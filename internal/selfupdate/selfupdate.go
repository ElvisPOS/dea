// Package selfupdate restarts a program when its binary file is replaced, so
// installing a new version is just copying it into place.
//
// Every Interval the binary's size and modification time are checked. Once a
// changed file has stopped changing (a copy in progress is never started), the
// new file is run with -version: a file that does not run is reported once and
// ignored, and so is the same file copied again. The program then exits as soon as nothing is in use (no terminal or
// screen open), or after MaxWait at the latest, and whatever keeps it running
// (the POS start loop, Docker's restart policy) starts the new version.
package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	Interval = 30 * time.Second
	MaxWait  = time.Hour
)

// Watch starts watching the running binary. busy tells how many sessions are
// open; restart is called once, when it is time to switch.
func Watch(current string, busy func() int, restart func()) {
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		log.Printf("self-update: cannot find my binary: %v", err)
		return
	}
	start, err := os.Stat(exe)
	if err != nil {
		log.Printf("self-update: %v", err)
		return
	}
	sum, err := fileSum(exe)
	if err != nil {
		log.Printf("self-update: %v", err)
		return
	}
	go watch(exe, current, start, sum, busy, restart, Interval, MaxWait)
}

func watch(exe, current string, base os.FileInfo, sum string, busy func() int, restart func(), interval, maxWait time.Duration) {
	var last os.FileInfo // the changed file as seen at the previous check
	var found time.Time  // when a new, runnable version was found
	var next string
	for range time.Tick(interval) {
		st, err := os.Stat(exe)
		if err != nil || same(st, base) {
			last, found = nil, time.Time{}
			continue
		}
		if found.IsZero() {
			if last == nil || !same(st, last) { // still being copied
				last = st
				continue
			}
			if s, err := fileSum(exe); err == nil && s == sum {
				base, last = st, nil // the same file copied again
				continue
			}
			v, err := version(exe)
			if err != nil {
				log.Printf("self-update: %s was replaced but does not run (%v): keeping %s", exe, err, current)
				base, last = st, nil // until it is replaced again
				continue
			}
			found, next = time.Now(), v
			log.Printf("self-update: %s found, restarting when no session is open (at most %s)", next, maxWait)
		}
		n := busy()
		if n > 0 && time.Since(found) < maxWait {
			continue
		}
		if n > 0 {
			log.Printf("self-update: restarting into %s now, closing %d open sessions", next, n)
		} else {
			log.Printf("self-update: restarting into %s", next)
		}
		restart()
		return
	}
}

func fileSum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func same(a, b os.FileInfo) bool {
	return a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}

// version runs the new binary with -version.
func version(exe string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, exe, "-version").CombinedOutput() // both binaries print it with println (stderr)
	v := strings.TrimSpace(string(out))
	if err == nil && v == "" {
		err = os.ErrInvalid
	}
	return v, err
}
