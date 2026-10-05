package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"dea/internal/proto"
)

// Log files are the ones under /usr/share/elvispos whose name contains ".log"
// or that sit in a "log"/"logs" folder, at most maxLogDepth levels down
// (e.g. client_agent/log/elvis-CLIENT0.log). Only those can be downloaded.

const (
	logRoot     = "/usr/share/elvispos"
	maxLogDepth = 3 // root/<component>/log/<file>
)

func isLogFile(rel string) bool {
	name := filepath.Base(rel)
	if strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".lck") {
		return false
	}
	parent := filepath.Base(filepath.Dir(rel))
	return strings.Contains(name, ".log") || parent == "log" || parent == "logs"
}

func listLogs() []proto.LogFile {
	var files []proto.LogFile
	filepath.WalkDir(logRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped
		}
		rel, _ := filepath.Rel(logRoot, p)
		depth := strings.Count(rel, string(filepath.Separator))
		if d.IsDir() {
			if p != logRoot && (strings.HasPrefix(d.Name(), ".") || depth >= maxLogDepth-1) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || !isLogFile(rel) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		files = append(files, proto.LogFile{Path: p, Name: rel, Size: info.Size(), ModTime: info.ModTime()})
		return nil
	})
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files
}

// allowedLog returns the archive name of p if it is a log file under logRoot.
func allowedLog(p string) (string, bool) {
	rel, err := filepath.Rel(logRoot, filepath.Clean(p))
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || strings.Count(rel, string(filepath.Separator)) >= maxLogDepth || !isLogFile(rel) {
		return "", false
	}
	return filepath.Join(filepath.Base(logRoot), rel), true
}

func (a *agent) logListResult() proto.Msg {
	b, _ := json.Marshal(listLogs())
	return proto.Msg{Output: string(b)}
}

// wsWriter turns writes into binary frames on a session socket.
type wsWriter struct{ c *conn }

func (w wsWriter) Write(p []byte) (int, error) {
	if err := w.c.sendBinary(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// downloadLogs dials back a session and streams the requested log files as a .tar.gz.
func (a *agent) downloadLogs(m proto.Msg) {
	raw, err := a.dial("/api/agent/session?sid=" + m.Session)
	if err != nil {
		log.Printf("logs %.8s: dial: %v", m.Session, err)
		return
	}
	c := &conn{Conn: raw}
	defer c.Close()

	type entry struct{ path, name string }
	var entries []entry
	for _, p := range m.Files {
		name, ok := allowedLog(p)
		if st, err := os.Lstat(p); err != nil || !st.Mode().IsRegular() {
			ok = false
		}
		if !ok {
			c.send(proto.Msg{Type: proto.TypeError, Error: "not a log file: " + p})
			return
		}
		entries = append(entries, entry{p, name})
	}
	if len(entries) == 0 {
		c.send(proto.Msg{Type: proto.TypeError, Error: "no files requested"})
		return
	}

	start := time.Now()
	buf := bufio.NewWriterSize(wsWriter{c}, 32<<10)
	gz := gzip.NewWriter(buf)
	tw := tar.NewWriter(gz)
	var total int64
	for _, e := range entries {
		n, err := addToTar(tw, e.path, e.name)
		if err != nil {
			log.Printf("logs %.8s: %s: %v", m.Session, e.path, err)
			return // the browser sees a truncated download
		}
		total += n
	}
	if err := tw.Close(); err == nil {
		if err = gz.Close(); err == nil {
			err = buf.Flush()
		}
	}
	c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	log.Printf("logs %.8s: sent %d files (%d bytes) in %s", m.Session, len(entries), total, time.Since(start).Round(time.Millisecond))
}

// addToTar copies a file that may still be growing or rotating: it writes
// exactly the size seen at open time, padding if the file shrank meanwhile.
func addToTar(tw *tar.Writer, path, name string) (int64, error) {
	if st, err := os.Lstat(path); err != nil {
		return 0, err
	} else if !st.Mode().IsRegular() {
		return 0, errors.New("not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	hdr := &tar.Header{Name: name, Mode: 0o644, Size: info.Size(), ModTime: info.ModTime(), Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		return 0, err
	}
	n, err := io.CopyN(tw, f, info.Size())
	if errors.Is(err, io.EOF) {
		_, err = io.CopyN(tw, zeroReader{}, info.Size()-n)
	}
	return info.Size(), err
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}
