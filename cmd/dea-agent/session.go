package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"

	"dea/internal/proto"
)

// session runs an interactive login shell on a PTY and streams it over a
// dedicated WebSocket back to the server.
func (a *agent) session(open proto.Msg) {
	openSessions.Add(1)
	defer openSessions.Add(-1)
	raw, err := a.dial("/api/agent/session?sid=" + open.Session)
	if err != nil {
		log.Printf("session %.8s: dial: %v", open.Session, err)
		return
	}
	c := &conn{Conn: raw}
	defer c.Close()

	cmd := exec.Command(a.shell)
	cmd.Args = []string{"-" + filepath.Base(a.shell)} // leading dash = login shell
	cmd.Dir = a.home
	cmd.Env = a.shellEnv()
	tty, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: open.Cols, Rows: open.Rows})
	if err != nil {
		c.send(proto.Msg{Type: proto.TypeError, Error: "start shell: " + err.Error()})
		return
	}
	defer tty.Close()
	log.Printf("session %.8s: started %s (pid %d) for %s", open.Session, a.shell, cmd.Process.Pid, orUnknown(open.By))

	// Shell output -> server.
	outDone := make(chan struct{})
	go func() {
		defer close(outDone)
		buf := make([]byte, 32<<10)
		for {
			n, err := tty.Read(buf)
			if n > 0 {
				if c.sendBinary(buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// Server -> shell input / resize, and files dropped on the terminal.
	go func() {
		watchDeadline(c.Conn)
		var up *upload // the file being received, if any
		for {
			mt, data, err := c.ReadMessage()
			if err != nil {
				break
			}
			c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
			if mt == websocket.BinaryMessage {
				if up != nil {
					up = a.receive(c, open.Session, open.By, up, data)
				} else {
					tty.Write(data)
				}
				continue
			}
			var m proto.Msg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			switch m.Type {
			case proto.TypeResize:
				if m.Cols > 0 && m.Rows > 0 {
					pty.Setsize(tty, &pty.Winsize{Cols: m.Cols, Rows: m.Rows})
				}
			case proto.TypeUpload:
				if up != nil {
					const busy = "another upload is in progress"
					c.send(proto.Msg{Type: proto.TypeUploadError, Name: m.Name, Error: busy})
					auditUpload(uploadEvent{Event: "refused", Session: open.Session, By: open.By, Name: m.Name, Size: m.Size, Error: busy})
					continue
				}
				up = a.beginUpload(c, open.Session, open.By, tty, cmd.Process.Pid, m)
				if up != nil && up.complete() { // empty file
					up = a.receive(c, open.Session, open.By, up, nil)
				}
			case proto.TypeUploadCancel:
				if up != nil {
					up.abort()
					auditUpload(up.event("cancelled", open.Session, open.By, "cancelled by the user"))
					up = nil
				}
			}
		}
		if up != nil {
			up.abort()
			auditUpload(up.event("interrupted", open.Session, open.By, "the terminal closed during the upload"))
		}
		// Browser went away: hang up the shell's whole process group.
		syscall.Kill(-cmd.Process.Pid, syscall.SIGHUP)
	}()

	err = cmd.Wait()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	}
	select { // flush remaining output
	case <-outDone:
	case <-time.After(500 * time.Millisecond):
	}
	c.send(proto.Msg{Type: proto.TypeExit, Code: code})
	c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	log.Printf("session %.8s: ended (exit %d)", open.Session, code)
}

// runCommand runs a one-shot shell command, returning combined output capped at MaxExecOutput.
func runCommand(ctx context.Context, a *agent, script string) (string, int, error) {
	cmd := exec.CommandContext(ctx, a.shell, "-c", script)
	cmd.Dir = a.home
	cmd.Env = a.shellEnv()
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	var out capBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code, err = ee.ExitCode(), nil
	}
	s := out.String()
	if out.truncated {
		s += "\n[output truncated]"
	}
	return s, code, err
}

type capBuffer struct {
	bytes.Buffer
	truncated bool
}

func (b *capBuffer) Write(p []byte) (int, error) {
	if room := proto.MaxExecOutput - b.Len(); room < len(p) {
		b.truncated = true
		if room > 0 {
			b.Buffer.Write(p[:room])
		}
		return len(p), nil
	}
	return b.Buffer.Write(p)
}

// beginUpload answers an upload request: ready (with the target path), or an error.
func (a *agent) beginUpload(c *conn, sid, by string, tty *os.File, shellPid int, m proto.Msg) *upload {
	ev := uploadEvent{Session: sid, By: by, Name: m.Name, Size: m.Size}
	fail := func(err error) *upload {
		c.send(proto.Msg{Type: proto.TypeUploadError, Name: m.Name, Error: err.Error()})
		ev.Event, ev.Error = "refused", err.Error()
		auditUpload(ev)
		return nil
	}
	dir, err := terminalDir(tty, shellPid)
	if err != nil {
		return fail(err)
	}
	ev.Path = filepath.Join(dir, m.Name)
	up, exists, err := startUpload(dir, m)
	if err != nil {
		return fail(err)
	}
	if exists {
		c.send(proto.Msg{Type: proto.TypeUploadError, Name: m.Name, Path: ev.Path, Exists: true})
		ev.Event, ev.Error = "exists", "file exists, the user is asked to replace it"
		auditUpload(ev)
		return nil
	}
	auditUpload(up.event("started", sid, by, ""))
	c.send(proto.Msg{Type: proto.TypeUploadReady, Name: up.name, Path: up.path})
	return up
}

// receive stores a chunk and reports progress; it returns nil once the file is complete.
// After a write error the browser is told once; it then cancels, and anything
// still in flight is read and dropped.
func (a *agent) receive(c *conn, sid, by string, up *upload, data []byte) *upload {
	if err := up.write(data); err != nil {
		c.send(proto.Msg{Type: proto.TypeUploadError, Name: up.name, Path: up.path, Error: err.Error()})
		auditUpload(up.event("failed", sid, by, err.Error()))
	}
	switch {
	case !up.complete():
		if !up.failed && up.got-up.lastAck >= progressStep {
			up.lastAck = up.got
			c.send(proto.Msg{Type: proto.TypeUploadProgress, Name: up.name, Size: up.got})
		}
		return up
	case up.failed:
		up.abort()
	default:
		if err := up.finish(); err != nil {
			c.send(proto.Msg{Type: proto.TypeUploadError, Name: up.name, Path: up.path, Error: err.Error()})
			auditUpload(up.event("failed", sid, by, err.Error()))
			return nil
		}
		ev := up.event("saved", sid, by, "")
		auditUpload(ev)
		c.send(proto.Msg{Type: proto.TypeUploadDone, Name: up.name, Path: up.path, Size: up.size, SHA256: ev.SHA256,
			Replaced: up.replaced, OldSize: up.oldSize, OldSHA256: up.oldSHA256, Backup: up.backup})
	}
	return nil
}

func orUnknown(s string) string {
	if s == "" {
		return "an unknown user (server older than v2.3.1)"
	}
	return s
}
