package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"

	"dea/internal/proto"
)

func TestUploadSavesTheFile(t *testing.T) {
	dir := t.TempDir()
	u, exists, err := startUpload(dir, proto.Msg{Name: "price.csv", Size: 10})
	if err != nil || exists {
		t.Fatal(err, exists)
	}
	u.write([]byte("hello"))
	if u.complete() {
		t.Fatal("complete after 5 of 10 bytes")
	}
	u.write([]byte("world and more")) // anything past Size is ignored
	if !u.complete() {
		t.Fatal("not complete")
	}
	if err := u.finish(); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "price.csv"))
	if string(b) != "helloworld" {
		t.Fatalf("got %q", b)
	}
	sum := sha256.Sum256(b)
	if e := u.event("saved", "s1", "admin@10.8.0.5", ""); e.SHA256 != hex.EncodeToString(sum[:]) || e.Bytes != 10 || e.By != "admin@10.8.0.5" {
		t.Fatalf("audit record %+v", e)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".*dea-upload*")); len(left) > 0 {
		t.Fatalf("temporary file left: %v", left)
	}
}

func TestUploadAsksBeforeReplacing(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "run.sh")
	os.WriteFile(target, []byte("old"), 0o755)

	u, exists, err := startUpload(dir, proto.Msg{Name: "run.sh", Size: 3})
	if u != nil || !exists || err != nil {
		t.Fatalf("want exists, got %v %v %v", u, exists, err)
	}
	u, _, err = startUpload(dir, proto.Msg{Name: "run.sh", Size: 3, Overwrite: true})
	if err != nil {
		t.Fatal(err)
	}
	u.write([]byte("new"))
	if err := u.finish(); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(target)
	b, _ := os.ReadFile(target)
	if string(b) != "new" || st.Mode().Perm() != 0o755 {
		t.Fatalf("got %q mode %v; want the new content and the old mode", b, st.Mode().Perm())
	}
	if e := u.event("saved", "s1", "", ""); !e.Replaced || e.OldSize != 3 {
		t.Fatalf("replace not recorded: %+v", e)
	}
}

func TestUploadRejects(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "sub"), 0o755)
	for _, m := range []proto.Msg{
		{Name: "../x", Size: 1},
		{Name: "a/b", Size: 1},
		{Name: "..", Size: 1},
		{Name: "", Size: 1},
		{Name: "big.iso", Size: maxUpload + 1},
		{Name: "sub", Size: 1, Overwrite: true},
	} {
		if _, _, err := startUpload(dir, m); err == nil {
			t.Errorf("%q (%d bytes) accepted", m.Name, m.Size)
		}
	}
	os.Chmod(dir, 0o555)
	defer os.Chmod(dir, 0o755)
	if os.Geteuid() != 0 {
		if _, _, err := startUpload(dir, proto.Msg{Name: "x", Size: 1}); err == nil || !strings.Contains(err.Error(), "no permission") {
			t.Errorf("read-only folder: %v", err)
		}
	}
}

func TestUploadAbortLeavesNothing(t *testing.T) {
	dir := t.TempDir()
	u, _, _ := startUpload(dir, proto.Msg{Name: "half.bin", Size: 100})
	u.write(make([]byte, 50))
	u.abort()
	if entries, _ := os.ReadDir(dir); len(entries) > 0 {
		t.Fatalf("left %v", entries)
	}
}

// The folder is the one of the program in the foreground of the terminal.
func TestTerminalDirFollowsTheShell(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command("/bin/sh", "-c", "cd "+dir+" && sleep 5")
	tty, err := pty.Start(cmd)
	if err != nil {
		t.Skip("no pty:", err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait(); tty.Close() }()
	want, _ := filepath.EvalSymlinks(dir)
	deadline := time.Now().Add(3 * time.Second)
	for {
		got, err := terminalDir(tty, cmd.Process.Pid)
		if err == nil && got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("got %q, %v; want %q", got, err, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
