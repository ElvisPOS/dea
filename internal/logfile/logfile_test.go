package logfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRotates(t *testing.T) {
	dir := t.TempDir()
	l, err := Open(filepath.Join(dir, "log"), "x.log", 100, 2)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Repeat("a", 39) + "\n" // 40 bytes: two lines per file
	for i := 0; i < 7; i++ {
		if _, err := l.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	for name, want := range map[string]int64{"x.log": 40, "x.log.1": 80, "x.log.2": 80, "x.log.3": -1} {
		fi, err := os.Stat(filepath.Join(dir, "log", name))
		switch {
		case want < 0 && err == nil:
			t.Errorf("%s should not exist", name)
		case want >= 0 && (err != nil || fi.Size() != want):
			t.Errorf("%s: %v, size %v, want %d", name, err, fi, want)
		}
	}
}

func TestReopensWhenRemoved(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "log")
	l, err := Open(dir, "x.log", 1000, 2)
	if err != nil {
		t.Fatal(err)
	}
	l.Write([]byte("one\n"))
	os.RemoveAll(dir)
	l.Write([]byte("two\n"))
	if b, err := os.ReadFile(filepath.Join(dir, "x.log")); err != nil || string(b) != "two\n" {
		t.Fatalf("got %q, %v", b, err)
	}
}
