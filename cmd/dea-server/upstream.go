package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/websocket"

	"dea/internal/proto"
)

// Store side of a store <-> central link. The store dials out to central, sends
// periodic snapshots of its agents, and relays the terminals and commands
// central asks for to its own agents.

var upstreamDialer = &websocket.Dialer{HandshakeTimeout: 15 * time.Second, Proxy: http.ProxyFromEnvironment}

func (s *server) dialUpstream(path string) (*wsConn, error) {
	h := http.Header{"Authorization": {"Bearer " + s.cfg.UpstreamToken}}
	c, resp, err := upstreamDialer.Dial(s.cfg.Upstream+path, h)
	if err != nil {
		if resp != nil {
			err = fmt.Errorf("%w (%s)", err, resp.Status)
		}
		return nil, err
	}
	return &wsConn{Conn: c}, nil
}

func (s *server) runUpstream() {
	log.Printf("upstream: linking to %s as store %q", s.cfg.Upstream, s.cfg.StoreID)
	backoff := time.Second
	for {
		start := time.Now()
		err := s.upstreamOnce()
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		wait := backoff + time.Duration(rand.Int63n(int64(backoff)))
		log.Printf("upstream: disconnected: %v (retry in %s)", err, wait.Round(time.Second))
		time.Sleep(wait)
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (s *server) upstreamOnce() error {
	c, err := s.dialUpstream("/api/store/connect")
	if err != nil {
		return err
	}
	defer c.Close()

	hostname, _ := os.Hostname()
	hello := proto.Msg{Type: proto.TypeHello, ID: s.cfg.StoreID, Hostname: hostname, Version: version}
	if err := c.WriteJSON(hello); err != nil {
		return err
	}
	log.Printf("upstream: connected to %s", s.cfg.Upstream)

	done := make(chan struct{})
	defer close(done)
	go s.pushSnapshots(c, done)

	c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
	c.SetPingHandler(func(data string) error {
		c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
		return c.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(proto.WriteTimeout))
	})
	for {
		var m proto.Msg
		if err := c.ReadJSON(&m); err != nil {
			return err
		}
		c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
		switch m.Type {
		case proto.TypeOpen, proto.TypeLogDownload, proto.TypeVNC:
			go s.relaySession(m)
		case proto.TypeLogList, proto.TypeVNCCheck:
			go func() {
				res, err := s.request(m.Agent, proto.Msg{Type: m.Type}, 30*time.Second)
				if err != nil {
					res.Error = err.Error()
				}
				c.WriteJSON(proto.Msg{Type: proto.TypeExecResult, Req: m.Req, Output: res.Output, Error: res.Error})
			}()
		case proto.TypeExec:
			go func() {
				log.Printf("exec via upstream agent=%s cmd=%q", m.Agent, m.Cmd)
				r := s.execOne(m.Agent, m.Cmd, m.Timeout)
				c.WriteJSON(proto.Msg{Type: proto.TypeExecResult, Req: m.Req, Code: r.Code, Output: r.Output, Error: r.Error})
			}()
		case proto.TypeForget:
			if err := s.hub.Forget(m.Agent); err != nil {
				log.Printf("forget %s via upstream: %v", m.Agent, err)
			}
		}
	}
}

// pushSnapshots sends the agent list whenever it changes (at most every 2s),
// and at least every 30s.
func (s *server) pushSnapshots(c *wsConn, done <-chan struct{}) {
	var last []byte
	lastSent := time.Time{}
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		agents, _ := s.hub.List()
		// LastSeen moves on every ping and stats every minute; leave them out of
		// the change check, so resource usage goes up with the periodic refresh only.
		cmp := make([]proto.AgentInfo, len(agents))
		for i, a := range agents {
			a.LastSeen, a.Stats = time.Time{}, nil
			cmp[i] = a
		}
		b, _ := json.Marshal(cmp)
		if !bytes.Equal(b, last) || time.Since(lastSent) > proto.SnapshotInterval {
			if err := c.WriteJSON(proto.Msg{Type: proto.TypeAgents, Agents: agents, Stats: s.selfStats()}); err != nil {
				c.Close()
				return
			}
			last, lastSent = b, time.Now()
		}
		select {
		case <-done:
			return
		case <-t.C:
		}
	}
}

// relaySession connects a session requested by central (a terminal or a log
// download) to one of our agents.
func (s *server) relaySession(m proto.Msg) {
	up, err := s.dialUpstream("/api/store/session?sid=" + m.Session)
	if err != nil {
		log.Printf("relay session %.8s: dial upstream: %v", m.Session, err)
		return
	}
	defer up.Close()
	sid := m.Session
	fwd := m
	fwd.Agent, fwd.Session, fwd.Req = "", "", ""
	down, err := s.openAgentSession(m.Agent, fwd)
	m.Session = sid
	if err != nil {
		up.WriteJSON(proto.Msg{Type: proto.TypeError, Error: err.Error()})
		up.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
		return
	}
	defer down.Close()
	start := time.Now()
	log.Printf("session open  sid=%.8s agent=%s via=upstream", m.Session, m.Agent)
	s.hub.sessionDelta(m.Agent, +1)
	defer func() {
		s.hub.sessionDelta(m.Agent, -1)
		log.Printf("session close sid=%.8s agent=%s via=upstream after=%s", m.Session, m.Agent, time.Since(start).Round(time.Second))
	}()
	user := m.By // who opened the session on central, "user@address"
	if user == "" {
		user = "(central)"
	}
	uploads := newUploadAudit(hostname(), m.Agent, user, "upstream", m.Session[:min(8, len(m.Session))])
	defer uploads.close()
	splice(up, down, uploads.frame)
}
