package selfupdate

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func script(t *testing.T, path, body string) {
	t.Helper()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, path); err != nil { // as rsync does: a new file in place
		t.Fatal(err)
	}
}

func run(t *testing.T, busy func() int, maxWait ...time.Duration) (exe string, restarted *atomic.Bool) {
	wait := time.Hour
	if len(maxWait) > 0 {
		wait = maxWait[0]
	}
	exe = filepath.Join(t.TempDir(), "dea-agent")
	script(t, exe, "echo v1 >&2")
	base, _ := os.Stat(exe)
	sum, _ := fileSum(exe)
	restarted = new(atomic.Bool)
	go watch(exe, "v1", base, sum, busy, func() { restarted.Store(true) }, 20*time.Millisecond, wait)
	return exe, restarted
}

func waitFor(cond func() bool, d time.Duration) bool {
	for end := time.Now().Add(d); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
		if cond() {
			return true
		}
	}
	return cond()
}

func TestRestartsWhenANewVersionIsCopiedAndIdle(t *testing.T) {
	var open atomic.Int32
	open.Store(1)
	exe, restarted := run(t, func() int { return int(open.Load()) })
	time.Sleep(50 * time.Millisecond)
	script(t, exe, "echo v2 >&2")
	if waitFor(restarted.Load, 300*time.Millisecond) {
		t.Fatal("restarted while a session was open")
	}
	open.Store(0)
	if !waitFor(restarted.Load, time.Second) {
		t.Fatal("did not restart once idle")
	}
}

func TestIgnoresABinaryThatDoesNotRun(t *testing.T) {
	exe, restarted := run(t, func() int { return 0 })
	time.Sleep(50 * time.Millisecond)
	script(t, exe, "exit 1")
	if waitFor(restarted.Load, 400*time.Millisecond) {
		t.Fatal("restarted into a broken binary")
	}
}

func TestIgnoresTheSameFileCopiedAgain(t *testing.T) {
	exe, restarted := run(t, func() int { return 0 })
	time.Sleep(50 * time.Millisecond)
	script(t, exe, "echo v1 >&2") // same bytes, new file and time
	if waitFor(restarted.Load, 400*time.Millisecond) {
		t.Fatal("restarted for the same file")
	}
}

func TestRestartsForARebuildWithTheSameVersion(t *testing.T) {
	exe, restarted := run(t, func() int { return 0 })
	time.Sleep(50 * time.Millisecond)
	script(t, exe, "echo v1 >&2 # rebuilt from uncommitted changes")
	if !waitFor(restarted.Load, time.Second) {
		t.Fatal("a different binary with the same version was ignored")
	}
}

func TestMaxWaitEndsTheWait(t *testing.T) {
	exe, restarted := run(t, func() int { return 3 }, 100*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	script(t, exe, "echo v2 >&2")
	if !waitFor(restarted.Load, 2*time.Second) {
		t.Fatal("never restarted although MaxWait passed")
	}
}
