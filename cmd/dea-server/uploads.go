package main

import (
	"encoding/json"
	"io"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"dea/internal/proto"
)

// Every file uploaded through a terminal is logged here, from the request to
// its outcome: one line in the server log per event, and one JSON line in
// <DEA_LOG_DIR>/uploads.log, the upload audit trail. The upload messages run
// inside the terminal's session link (see cmd/dea-agent/upload.go); this
// server sees them as it splices that link.

// uploadLog receives the JSON audit lines; nil when DEA_LOG_DIR is not set.
var uploadLog io.Writer

// uploadEvent is one line of uploads.log.
type uploadEvent struct {
	Time       time.Time `json:"time"`
	Event      string    `json:"event"` // requested, exists, refused, started, saved, failed, cancelled, interrupted
	Server     string    `json:"server"`
	Agent      string    `json:"agent"`
	User       string    `json:"user"`
	From       string    `json:"from,omitempty"` // browser address, or "upstream" on a store
	Session    string    `json:"session"`
	Name       string    `json:"name"`
	Size       int64     `json:"size"`
	Overwrite  bool      `json:"overwrite,omitempty"`
	Path       string    `json:"path,omitempty"`
	Bytes      int64     `json:"bytes"` // sent towards the POS so far
	SHA256     string    `json:"sha256,omitempty"`
	Replaced   bool      `json:"replaced,omitempty"`
	OldSize    int64     `json:"old_size,omitempty"`
	Error      string    `json:"error,omitempty"`
	DurationMS int64     `json:"duration_ms,omitempty"`
}

// uploadAudit follows the uploads of one terminal session.
type uploadAudit struct {
	mu                              sync.Mutex
	server, agent, user, from, sess string
	cur                             *uploadEvent // the upload in progress
	start                           time.Time
	sending                         bool // upload_ready seen: binary frames from above are file data
}

func newUploadAudit(server, agent, user, from, session string) *uploadAudit {
	return &uploadAudit{server: server, agent: agent, user: user, from: from, sess: session}
}

// frame is splice's tap: every frame, with its direction (down = towards the POS).
func (u *uploadAudit) frame(down bool, mt int, data []byte) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if mt == websocket.BinaryMessage {
		if down && u.sending && u.cur != nil {
			u.cur.Bytes += int64(len(data))
		}
		return
	}
	var m proto.Msg
	if json.Unmarshal(data, &m) != nil {
		return
	}
	switch {
	case down && m.Type == proto.TypeUpload:
		if u.cur != nil { // a new request ends any upload left open
			u.emit("interrupted", "superseded by a new upload")
		}
		u.cur = &uploadEvent{Name: m.Name, Size: m.Size, Overwrite: m.Overwrite}
		u.start, u.sending = time.Now(), false
		u.emit("requested", "")
	case down && m.Type == proto.TypeUploadCancel && u.cur != nil:
		u.emit("cancelled", "cancelled by the user")
		u.cur = nil
	case !down && m.Type == proto.TypeUploadReady && u.cur != nil:
		u.cur.Path, u.sending = m.Path, true
		u.emit("started", "")
	case !down && m.Type == proto.TypeUploadDone && u.cur != nil:
		u.cur.Path, u.cur.SHA256, u.cur.Replaced, u.cur.OldSize = m.Path, m.SHA256, m.Replaced, m.OldSize
		u.emit("saved", "")
		u.cur = nil
	case !down && m.Type == proto.TypeUploadError && u.cur != nil:
		switch {
		case m.Exists:
			u.cur.Path = m.Path
			u.emit("exists", "file exists, the user is asked to replace it")
		case u.sending:
			u.emit("failed", m.Error)
		default:
			u.emit("refused", m.Error)
		}
		u.cur = nil
	}
}

// close logs an upload the session ended in the middle of.
func (u *uploadAudit) close() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.cur != nil {
		u.emit("interrupted", "the terminal closed during the upload")
		u.cur = nil
	}
}

func (u *uploadAudit) emit(event, reason string) {
	e := *u.cur
	e.Time, e.Event, e.Error = time.Now(), event, reason
	e.Server, e.Agent, e.User, e.From, e.Session = u.server, u.agent, u.user, u.from, u.sess
	if event != "requested" {
		e.DurationMS = time.Since(u.start).Milliseconds()
	}
	log.Printf("upload %s id=%s agent=%s user=%q from=%s file=%q size=%d overwrite=%v path=%q bytes=%d sha256=%s replaced=%v old_size=%d after=%s error=%q",
		event, e.Session, e.Agent, e.User, e.From, e.Name, e.Size, e.Overwrite, e.Path, e.Bytes, e.SHA256, e.Replaced, e.OldSize,
		(time.Duration(e.DurationMS) * time.Millisecond).String(), e.Error)
	if uploadLog != nil {
		b, _ := json.Marshal(e)
		uploadLog.Write(append(b, '\n'))
	}
}
