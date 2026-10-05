// Package sysstat samples a Linux host's CPU, memory and disk usage from /proc
// and statfs. Inside a container /proc/stat, /proc/meminfo, /proc/loadavg and
// /proc/uptime still describe the host; disks are measured through paths that
// sit on the host filesystems (see Probe).
package sysstat

import (
	"bufio"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"dea/internal/proto"
)

// Probe is a disk to measure: Path is statfs'ed, Label is what the UI shows.
type Probe struct {
	Label string
	Path  string
}

// Sampler keeps the previous CPU counters, so each sample reports the CPU
// usage since the one before.
type Sampler struct {
	mu          sync.Mutex
	total, idle uint64
	have        bool
}

func (s *Sampler) Sample(probes []Probe) *proto.Stats {
	st := &proto.Stats{At: time.Now().UTC(), Load: loadavg(), Disks: disks(probes), Uptime: uptime()}
	st.CPU, st.CPUs = s.cpu()
	m := meminfo()
	st.MemTotal = m["MemTotal"]
	avail, ok := m["MemAvailable"]
	if !ok {
		avail = m["MemFree"] + m["Buffers"] + m["Cached"]
	}
	st.MemUsed = sub(st.MemTotal, avail)
	st.SwapTotal = m["SwapTotal"]
	st.SwapUsed = sub(st.SwapTotal, m["SwapFree"])
	return st
}

func sub(a, b uint64) uint64 {
	if b > a {
		return 0
	}
	return a - b
}

// cpu returns the busy % since the previous call (the first call measures half a second).
func (s *Sampler) cpu() (float64, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	total, idle, n := cpuTimes()
	if !s.have {
		time.Sleep(500 * time.Millisecond)
		s.total, s.idle, s.have = total, idle, true
		total, idle, n = cpuTimes()
	}
	dt, di := total-s.total, idle-s.idle
	s.total, s.idle = total, idle
	if total == 0 || dt == 0 || di > dt {
		return 0, n
	}
	return float64(int((1-float64(di)/float64(dt))*1000+0.5)) / 10, n
}

// cpuTimes sums the "cpu" line of /proc/stat (guest time is already in user).
func cpuTimes() (total, idle uint64, cpus int) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 0 || !strings.HasPrefix(fields[0], "cpu") {
			continue
		}
		if fields[0] != "cpu" {
			cpus++
			continue
		}
		for i, v := range fields[1:] {
			if i >= 8 {
				break
			}
			n, _ := strconv.ParseUint(v, 10, 64)
			total += n
			if i == 3 || i == 4 { // idle, iowait
				idle += n
			}
		}
	}
	return
}

func meminfo() map[string]uint64 {
	m := map[string]uint64{}
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return m
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(v)
		if len(fields) == 0 {
			continue
		}
		n, _ := strconv.ParseUint(fields[0], 10, 64)
		if len(fields) > 1 && fields[1] == "kB" {
			n *= 1024
		}
		m[k] = n
	}
	return m
}

func loadavg() []float64 {
	b, _ := os.ReadFile("/proc/loadavg")
	f := strings.Fields(string(b))
	out := make([]float64, 0, 3)
	for i := 0; i < 3 && i < len(f); i++ {
		v, _ := strconv.ParseFloat(f[i], 64)
		out = append(out, v)
	}
	return out
}

func uptime() int64 {
	b, _ := os.ReadFile("/proc/uptime")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int64(v)
}

// disks measures each probe once per filesystem (bind mounts of the same
// filesystem report the same fsid): "/" first, then by path.
func disks(probes []Probe) []proto.Disk {
	seen := map[[2]int32]bool{}
	var out []proto.Disk
	for _, p := range probes {
		var fs syscall.Statfs_t
		if err := syscall.Statfs(p.Path, &fs); err != nil || fs.Blocks == 0 {
			continue
		}
		id := fs.Fsid.X__val
		if id == [2]int32{} {
			id = [2]int32{int32(fs.Blocks), int32(fs.Files)}
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		bs := uint64(fs.Bsize)
		out = append(out, proto.Disk{
			Path:  p.Label,
			Total: fs.Blocks * bs,
			Used:  (fs.Blocks - fs.Bfree) * bs,
			Avail: fs.Bavail * bs,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].Path == "/") != (out[j].Path == "/") {
			return out[i].Path == "/"
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// MountProbes lists the block-device filesystems of this host (what "df -x
// tmpfs" shows), for agents running directly on the POS.
func MountProbes() []Probe {
	b, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return []Probe{{"/", "/"}}
	}
	skip := map[string]bool{"squashfs": true, "iso9660": true, "udf": true}
	var out []Probe
	devs := map[string]bool{}
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Fields(l)
		if len(f) < 3 || !strings.HasPrefix(f[0], "/dev/") || skip[f[2]] || devs[f[0]] {
			continue
		}
		devs[f[0]] = true
		mnt := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\134`, `\`).Replace(f[1])
		out = append(out, Probe{mnt, mnt})
	}
	if len(out) == 0 {
		out = []Probe{{"/", "/"}}
	}
	return out
}

// ParseProbes reads "label=path,label=path" (DEA_DISKS).
func ParseProbes(spec string) []Probe {
	var out []Probe
	for _, item := range strings.Split(spec, ",") {
		label, path, ok := strings.Cut(strings.TrimSpace(item), "=")
		if ok && label != "" && path != "" {
			out = append(out, Probe{label, path})
		}
	}
	return out
}
