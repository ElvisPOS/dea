package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"

	"rterm/internal/proto"
)

// session runs an interactive login shell on a PTY and streams it over a
// dedicated WebSocket back to the server.
func (a *agent) session(open proto.Msg) {
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
	log.Printf("session %.8s: started %s (pid %d)", open.Session, a.shell, cmd.Process.Pid)

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

	// Server -> shell input / resize.
	go func() {
		watchDeadline(c.Conn)
		for {
			mt, data, err := c.ReadMessage()
			if err != nil {
				break
			}
			c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
			if mt == websocket.BinaryMessage {
				tty.Write(data)
				continue
			}
			var m proto.Msg
			if json.Unmarshal(data, &m) == nil && m.Type == proto.TypeResize && m.Cols > 0 && m.Rows > 0 {
				pty.Setsize(tty, &pty.Winsize{Cols: m.Cols, Rows: m.Rows})
			}
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
