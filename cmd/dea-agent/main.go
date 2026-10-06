// dea-agent runs on each POS. It keeps an outbound WebSocket to dea-server
// (so the POS never needs to accept inbound connections) and starts shells or
// one-shot commands when the server asks.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"log"
	"math/rand"
	"net"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"dea/internal/logfile"
	"dea/internal/proto"
	"dea/internal/sysstat"
)

var version = "dev"

type agent struct {
	server string // ws(s)://host:port
	token  string
	id     string
	shell  string
	home   string
	user   string
	stats  sysstat.Sampler
}

func main() {
	hostname, _ := os.Hostname()
	server := flag.String("server", os.Getenv("DEA_SERVER"), "server URL, e.g. ws://7.7.7.201:7681 (env DEA_SERVER)")
	token := flag.String("token", os.Getenv("DEA_TOKEN"), "agent token (env DEA_TOKEN)")
	id := flag.String("id", envOr("DEA_ID", hostname), "agent id shown in the UI (env DEA_ID)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		println(version)
		return
	}
	// stdout goes to log/dea-agent.log (see the start script): stamp every line
	log.SetFlags(log.LstdFlags)
	openUploadLog()
	if *server == "" || *token == "" {
		log.Fatal("DEA_SERVER and DEA_TOKEN are required")
	}

	a := &agent{server: strings.TrimRight(*server, "/"), token: *token, id: *id}
	a.user, a.home, a.shell = currentAccount()
	log.Printf("dea-agent %s id=%s user=%s shell=%s server=%s", version, a.id, a.user, a.shell, a.server)

	backoff := time.Second
	for {
		start := time.Now()
		err := a.run()
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		wait := backoff + time.Duration(rand.Int63n(int64(backoff)))
		log.Printf("disconnected: %v (retry in %s)", err, wait.Round(time.Second))
		time.Sleep(wait)
		backoff = min(backoff*2, 30*time.Second)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var dialer = &websocket.Dialer{HandshakeTimeout: 15 * time.Second, Proxy: http.ProxyFromEnvironment}

func (a *agent) dial(path string) (*websocket.Conn, error) {
	h := http.Header{"Authorization": {"Bearer " + a.token}}
	c, resp, err := dialer.Dial(a.server+path, h)
	if err != nil && resp != nil {
		err = &dialError{err, resp.Status}
	}
	return c, err
}

type dialError struct {
	err    error
	status string
}

func (e *dialError) Error() string { return e.err.Error() + " (" + e.status + ")" }

// conn serialises writes; gorilla allows only one concurrent writer.
type conn struct {
	*websocket.Conn
	wmu sync.Mutex
}

func (c *conn) send(m proto.Msg) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.SetWriteDeadline(time.Now().Add(proto.WriteTimeout))
	return c.WriteJSON(m)
}

func (c *conn) sendBinary(b []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.SetWriteDeadline(time.Now().Add(proto.WriteTimeout))
	return c.WriteMessage(websocket.BinaryMessage, b)
}

// watchDeadline extends the read deadline whenever the server pings us.
func watchDeadline(c *websocket.Conn) {
	c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
	c.SetPingHandler(func(data string) error {
		c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
		return c.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(proto.WriteTimeout))
	})
}

// run holds one control connection open until it fails.
func (a *agent) run() error {
	raw, err := a.dial("/api/agent/connect")
	if err != nil {
		return err
	}
	c := &conn{Conn: raw}
	defer c.Close()

	hostname, _ := os.Hostname()
	if err := c.send(proto.Msg{
		Type: proto.TypeHello, ID: a.id, Hostname: hostname, DeviceID: deviceID(), OS: osName(),
		Arch: runtime.GOARCH, User: a.user, Version: version, IPs: localIPs(),
	}); err != nil {
		return err
	}
	log.Printf("connected to %s", a.server)
	watchDeadline(c.Conn)
	done := make(chan struct{})
	defer close(done)
	go a.reportStats(c, done)

	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return err
		}
		c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
		var m proto.Msg
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		switch m.Type {
		case proto.TypeOpen:
			go a.session(m)
		case proto.TypeExec:
			go func() {
				res := a.exec(m)
				res.Type, res.Req = proto.TypeExecResult, m.Req
				c.send(res)
			}()
		case proto.TypeLogList:
			go func() {
				res := a.logListResult()
				res.Type, res.Req = proto.TypeExecResult, m.Req
				c.send(res)
			}()
		case proto.TypeLogDownload:
			go a.downloadLogs(m)
		case proto.TypeVNC:
			go a.vncSession(m)
		case proto.TypeVNCCheck:
			go func() {
				res := a.vncCheckResult()
				res.Type, res.Req = proto.TypeExecResult, m.Req
				c.send(res)
			}()
		}
	}
}

// reportStats sends the POS resource usage now and every StatsInterval.
func (a *agent) reportStats(c *conn, done <-chan struct{}) {
	t := time.NewTicker(proto.StatsInterval)
	defer t.Stop()
	for {
		if err := c.send(proto.Msg{Type: proto.TypeStats, Stats: a.stats.Sample(sysstat.MountProbes())}); err != nil {
			return
		}
		select {
		case <-done:
			return
		case <-t.C:
		}
	}
}

func (a *agent) exec(m proto.Msg) proto.Msg {
	timeout := time.Duration(m.Timeout) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	log.Printf("exec: %q", m.Cmd)
	out, code, err := runCommand(ctx, a, m.Cmd)
	res := proto.Msg{Output: out, Code: code}
	if ctx.Err() == context.DeadlineExceeded {
		res.Error = "timed out after " + timeout.String()
	} else if err != nil {
		res.Error = err.Error()
	}
	return res
}

// currentAccount returns the user name, home dir and login shell of the running process.
func currentAccount() (name, home, shell string) {
	u, err := user.Current()
	if err == nil {
		name, home = u.Username, u.HomeDir
	} else {
		name, home = strconv.Itoa(os.Getuid()), "/"
	}
	shell = "/bin/sh"
	if f, err := os.Open("/etc/passwd"); err == nil {
		defer f.Close()
		s := bufio.NewScanner(f)
		uid := strconv.Itoa(os.Getuid())
		for s.Scan() {
			p := strings.Split(s.Text(), ":")
			if len(p) >= 7 && p[2] == uid && p[6] != "" && !strings.HasSuffix(p[6], "nologin") && !strings.HasSuffix(p[6], "false") {
				shell = p[6]
				break
			}
		}
	}
	if _, err := os.Stat("/bin/bash"); shell == "/bin/sh" && err == nil {
		shell = "/bin/bash"
	}
	return
}

// shellEnv builds a clean login-like environment (systemd services start with almost none).
func (a *agent) shellEnv() []string {
	env := []string{
		"HOME=" + a.home, "USER=" + a.user, "LOGNAME=" + a.user, "SHELL=" + a.shell,
		"TERM=xterm-256color", "COLORTERM=truecolor",
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LANG=" + envOr("LANG", "C.UTF-8"),
	}
	if b, err := os.ReadFile("/etc/default/locale"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "LANG=") {
				env[len(env)-1] = "LANG=" + strings.Trim(strings.TrimPrefix(l, "LANG="), `"`)
			}
		}
	}
	return env
}

// deviceID returns ELVIS_DEVICE_ID from the POS environment file, if any.
func deviceID() string {
	b, err := os.ReadFile("/usr/share/elvispos/elvisenv")
	if err != nil {
		return ""
	}
	for _, l := range strings.Split(string(b), "\n") {
		l = strings.TrimPrefix(strings.TrimSpace(l), "export ")
		if v, ok := strings.CutPrefix(l, "ELVIS_DEVICE_ID="); ok {
			return strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return ""
}

func osName() string {
	b, err := os.ReadFile("/etc/os-release")
	if err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(l, "PRETTY_NAME="), `"`)
			}
		}
	}
	return runtime.GOOS
}

func localIPs() []string {
	var ips []string
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 ||
			strings.HasPrefix(ifc.Name, "docker") || strings.HasPrefix(ifc.Name, "veth") || strings.HasPrefix(ifc.Name, "br-") {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, ad := range addrs {
			if n, ok := ad.(*net.IPNet); ok && n.IP.To4() != nil {
				ips = append(ips, n.IP.String())
			}
		}
	}
	return ips
}

// openUploadLog opens log/uploads.log next to the agent binary, the upload audit trail.
func openUploadLog() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	f, err := logfile.Open(filepath.Join(filepath.Dir(exe), "log"), "uploads.log", 10<<20, 10)
	if err != nil {
		log.Printf("upload log: %v", err)
		return
	}
	uploadLog = f
}
