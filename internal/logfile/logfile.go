// Package logfile writes a log to a file that rotates by size: name, name.1 …
// name.<keep>, the oldest dropped.
package logfile

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

type File struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	keep     int
	uid, gid int // owner of the folder; files get the same owner
	f        *os.File
	size     int64
}

// Open opens dir/name for appending, creating dir if needed.
func Open(dir, name string, maxBytes int64, keep int) (*File, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	l := &File{path: filepath.Join(dir, name), maxBytes: maxBytes, keep: keep, uid: -1, gid: -1}
	if fi, err := os.Stat(dir); err == nil {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			l.uid, l.gid = int(st.Uid), int(st.Gid)
		}
	}
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *File) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	// the server runs as root in its container: hand the file to whoever owns the folder
	if l.uid >= 0 && os.Geteuid() == 0 {
		f.Chown(l.uid, l.gid)
	}
	l.f, l.size = f, fi.Size()
	return nil
}

func (l *File) rotate() error {
	l.f.Close()
	for i := l.keep - 1; i >= 1; i-- {
		os.Rename(fmt.Sprintf("%s.%d", l.path, i), fmt.Sprintf("%s.%d", l.path, i+1))
	}
	if l.keep > 0 {
		os.Rename(l.path, l.path+".1")
	} else {
		os.Remove(l.path)
	}
	return l.open()
}

func (l *File) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	// the file was removed (logs cleaned up): start a new one
	if _, err := os.Stat(l.path); err != nil && l.f != nil {
		l.f.Close()
		l.f = nil
		os.MkdirAll(filepath.Dir(l.path), 0o755)
	}
	if l.f == nil {
		if err := l.open(); err != nil {
			return 0, err
		}
	}
	if l.size > 0 && l.size+int64(len(p)) > l.maxBytes {
		if err := l.rotate(); err != nil {
			l.f = nil
			return 0, err
		}
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}
