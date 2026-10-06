package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"dea/internal/proto"
)

// Files dropped on a terminal travel inside that terminal's session socket
// (the servers in between splice it unchanged):
//
//	browser -> agent  {"type":"upload","name":…,"size":…,"overwrite":…}
//	agent -> browser  {"type":"upload_ready","path":…}  or  {"type":"upload_error",…}
//	browser -> agent  binary frames: the file, exactly size bytes
//	agent -> browser  {"type":"upload_progress","size":…} every progressStep, then {"type":"upload_done",…}
//	browser -> agent  {"type":"upload_cancel"} to stop early
//
// While an upload is open every binary frame is file data, never keystrokes.
// Agents older than this ignore "upload", so the browser never gets
// upload_ready and sends nothing.

const (
	maxUpload    = 1 << 30 // bytes
	progressStep = 1 << 20
)

// upload is one file being received into the terminal's current folder.
type upload struct {
	name, path string // final name and absolute path
	tmp        *os.File
	size, got  int64
	mode       fs.FileMode
	failed     bool // after an error the rest of the file is read and dropped
	start      time.Time
	lastAck    int64
	sum        hash.Hash // SHA-256 of what was written
	replaced   bool      // the target existed and is being replaced
	oldSize    int64
}

// startUpload checks the request against dir and opens a temporary file next to the target.
// exists is set when the target is already there and m.Overwrite is false.
func startUpload(dir string, m proto.Msg) (u *upload, exists bool, err error) {
	name := m.Name
	if name == "" || name == "." || name == ".." || len(name) > 255 || strings.ContainsAny(name, "/\x00") {
		return nil, false, errors.New("invalid file name")
	}
	if m.Size < 0 || m.Size > maxUpload {
		return nil, false, errors.New("file too large (max 1 GB)")
	}
	path := filepath.Join(dir, name)
	mode := fs.FileMode(0o644)
	var replaced bool
	var oldSize int64
	if st, err := os.Stat(path); err == nil {
		if st.IsDir() {
			return nil, false, fmt.Errorf("%s is a folder", path)
		}
		if !m.Overwrite {
			return nil, true, nil
		}
		mode = st.Mode().Perm() // a replaced script stays executable
		replaced, oldSize = true, st.Size()
	}
	var fsst syscall.Statfs_t
	if syscall.Statfs(dir, &fsst) == nil && int64(fsst.Bavail)*int64(fsst.Bsize) < m.Size+(16<<20) {
		return nil, false, errors.New("not enough free space in " + dir)
	}
	tmp, err := os.CreateTemp(dir, "."+name+".dea-upload-*")
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return nil, false, errors.New("no permission to write in " + dir)
		}
		return nil, false, err
	}
	return &upload{name: name, path: path, tmp: tmp, size: m.Size, mode: mode, start: time.Now(), sum: sha256.New(), replaced: replaced, oldSize: oldSize}, false, nil
}

// write stores a chunk; it reports the error once and drops the rest of the file after that.
func (u *upload) write(p []byte) error {
	if u.got+int64(len(p)) > u.size {
		p = p[:u.size-u.got] // the browser sends exactly size bytes; never more
	}
	u.got += int64(len(p))
	if u.failed {
		return nil
	}
	u.sum.Write(p)
	if _, err := u.tmp.Write(p); err != nil {
		u.failed = true
		if errors.Is(err, syscall.ENOSPC) {
			return errors.New("disk full")
		}
		return err
	}
	return nil
}

func (u *upload) complete() bool { return u.got >= u.size }

func (u *upload) sha256() string { return hex.EncodeToString(u.sum.Sum(nil)) }

// finish moves the file into place.
func (u *upload) finish() error {
	err := u.tmp.Chmod(u.mode)
	if err == nil {
		err = u.tmp.Sync()
	}
	if cerr := u.tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(u.tmp.Name(), u.path)
	}
	if err != nil {
		os.Remove(u.tmp.Name())
	}
	return err
}

// abort drops the partial file.
func (u *upload) abort() {
	u.tmp.Close()
	os.Remove(u.tmp.Name())
}

// terminalDir is the current folder of the program in the foreground of the
// terminal (the shell, or what it runs), so a file lands where the user is.
func terminalDir(tty *os.File, shellPid int) (string, error) {
	pid := shellPid
	var pgrp int32
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, tty.Fd(), syscall.TIOCGPGRP, uintptr(unsafe.Pointer(&pgrp))); e == 0 && pgrp > 0 {
		pid = int(pgrp)
	}
	dir, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return "", errors.New("the terminal runs a program as another user (sudo?): leave it to upload here, or upload elsewhere and move the file")
		}
		return "", err
	}
	return dir, nil
}

// ---- audit -----------------------------------------------------------------

// uploadLog receives one JSON line per upload event (log/uploads.log next to
// the agent); nil when it cannot be opened.
var uploadLog io.Writer

// uploadEvent is one line of uploads.log.
type uploadEvent struct {
	Time       time.Time `json:"time"`
	Event      string    `json:"event"` // exists, refused, started, saved, failed, cancelled, interrupted
	Session    string    `json:"session"`
	By         string    `json:"by"` // the DEA user who opened the terminal, "user@address"
	Name       string    `json:"name"`
	Size       int64     `json:"size"`
	Path       string    `json:"path,omitempty"`
	Bytes      int64     `json:"bytes"` // written so far
	SHA256     string    `json:"sha256,omitempty"`
	Replaced   bool      `json:"replaced,omitempty"`
	OldSize    int64     `json:"old_size,omitempty"`
	Error      string    `json:"error,omitempty"`
	DurationMS int64     `json:"duration_ms,omitempty"`
}

// auditUpload logs an upload event in the agent log and in uploads.log.
func auditUpload(e uploadEvent) {
	e.Time = time.Now()
	if len(e.Session) > 8 {
		e.Session = e.Session[:8] // as the agent log prints it
	}
	log.Printf("upload %s session=%s by=%q file=%q size=%d path=%q bytes=%d sha256=%s replaced=%v old_size=%d after=%s error=%q",
		e.Event, e.Session, e.By, e.Name, e.Size, e.Path, e.Bytes, e.SHA256, e.Replaced, e.OldSize,
		(time.Duration(e.DurationMS) * time.Millisecond).String(), e.Error)
	if uploadLog != nil {
		b, _ := json.Marshal(e)
		uploadLog.Write(append(b, '\n'))
	}
}

// event describes this upload for the audit.
func (u *upload) event(name, sid, by, errText string) uploadEvent {
	e := uploadEvent{Event: name, Session: sid, By: by, Name: u.name, Size: u.size, Path: u.path, Bytes: u.got,
		Replaced: u.replaced, OldSize: u.oldSize, Error: errText, DurationMS: time.Since(u.start).Milliseconds()}
	if name == "saved" {
		e.SHA256 = u.sha256()
	}
	return e
}
