package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"dea/internal/proto"
	"dea/internal/sysstat"
	"dea/web"
)

const (
	cookieName = "dea_session"
	loginTTL   = 12 * time.Hour
)

var validID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

type server struct {
	cfg       config
	hub       *Hub
	namesKick chan struct{} // nil unless names are fetched from ybservice

	sampler  sysstat.Sampler
	statsMu  sync.Mutex
	lastSelf *proto.Stats // this server's host, refreshed every StatsInterval
}

func (s *server) routes() http.Handler {
	static, _ := fs.Sub(web.FS, "static")
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })

	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", s.authed(s.handleMe))
	mux.HandleFunc("GET /api/agents", s.authed(s.handleAgents))
	mux.HandleFunc("DELETE /api/agents/{key...}", s.authed(s.handleForget))
	mux.HandleFunc("DELETE /api/stores/{id}", s.authed(s.handleForgetStore))
	mux.HandleFunc("POST /api/exec", s.authed(s.handleExec))
	mux.HandleFunc("GET /api/term", s.authed(s.handleTerm))
	mux.HandleFunc("GET /api/vnc", s.authed(s.handleVNC))
	mux.HandleFunc("GET /api/vnc/check", s.authed(s.handleVNCCheck))
	mux.HandleFunc("GET /api/logs", s.authed(s.handleLogList))
	mux.HandleFunc("GET /api/logs/download", s.authed(s.handleLogDownload))

	mux.HandleFunc("GET /api/agent/connect", s.tokenAuthed(s.cfg.AgentToken, s.handleAgentConnect))
	mux.HandleFunc("GET /api/agent/session", s.tokenAuthed(s.cfg.AgentToken, s.handleSessionDialBack))
	if s.cfg.StoreToken != "" {
		mux.HandleFunc("GET /api/store/connect", s.tokenAuthed(s.cfg.StoreToken, s.handleStoreConnect))
		mux.HandleFunc("GET /api/store/session", s.tokenAuthed(s.cfg.StoreToken, s.handleSessionDialBack))
	}
	return mux
}

// ---- browser auth ----------------------------------------------------------

func (s *server) sign(payload string) string {
	m := hmac.New(sha256.New, s.cfg.SessionSecret)
	m.Write([]byte(payload))
	return hex.EncodeToString(m.Sum(nil))
}

func (s *server) currentUser(r *http.Request) string {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return ""
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 3 {
		return ""
	}
	payload := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(parts[2]), []byte(s.sign(payload))) {
		return ""
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return ""
	}
	return parts[0]
}

func (s *server) authed(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.currentUser(r) == "" {
			httpError(w, http.StatusUnauthorized, "not logged in")
			return
		}
		h(w, r)
	}
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct{ User, Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "bad request")
		return
	}
	if !tokenEqual(req.User, s.cfg.AdminUser) || !tokenEqual(req.Password, s.cfg.AdminPassword) {
		log.Printf("login failed user=%q from=%s", req.User, r.RemoteAddr)
		time.Sleep(time.Second)
		httpError(w, http.StatusUnauthorized, "wrong user or password")
		return
	}
	exp := time.Now().Add(loginTTL)
	payload := req.User + "." + strconv.FormatInt(exp.Unix(), 10)
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: payload + "." + s.sign(payload), Path: "/",
		Expires: exp, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil,
	})
	log.Printf("login ok user=%q from=%s", req.User, r.RemoteAddr)
	writeJSON(w, map[string]string{"user": req.User})
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	me := map[string]string{
		"user":     s.currentUser(r),
		"upstream": s.cfg.Upstream,
		"store_id": s.cfg.StoreID,
	}
	if s.cfg.StoreToken != "" {
		me["store_setup"] = fmt.Sprintf("DEA_UPSTREAM_TOKEN=%s", s.cfg.StoreToken)
	}
	writeJSON(w, me)
}

// ---- browser API -----------------------------------------------------------

func (s *server) handleAgents(w http.ResponseWriter, r *http.Request) {
	agents, stores := s.hub.List()
	writeJSON(w, map[string]any{"agents": agents, "stores": stores, "server": s.selfInfo()})
}

func (s *server) handleForget(w http.ResponseWriter, r *http.Request) {
	if err := s.hub.Forget(r.PathValue("key")); err != nil {
		httpError(w, http.StatusConflict, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleForgetStore(w http.ResponseWriter, r *http.Request) {
	if err := s.hub.ForgetStore(r.PathValue("id")); err != nil {
		httpError(w, http.StatusConflict, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type execResult struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Code   int    `json:"code"`
	Output string `json:"output"`
	Error  string `json:"error,omitempty"`
	Millis int64  `json:"ms"`
}

func (s *server) handleExec(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agents  []string `json:"agents"`
		Cmd     string   `json:"cmd"`
		Timeout int      `json:"timeout"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || strings.TrimSpace(req.Cmd) == "" || len(req.Agents) == 0 {
		httpError(w, http.StatusBadRequest, "need agents and cmd")
		return
	}
	if req.Timeout <= 0 || req.Timeout > 600 {
		req.Timeout = 30
	}
	log.Printf("exec user=%q from=%s agents=%d cmd=%q", s.currentUser(r), r.RemoteAddr, len(req.Agents), req.Cmd)

	results := make([]execResult, len(req.Agents))
	var wg sync.WaitGroup
	for i, id := range req.Agents {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			results[i] = s.execOne(id, req.Cmd, req.Timeout)
		}(i, id)
	}
	wg.Wait()
	writeJSON(w, results)
}

// request sends a request (exec, log_list) to an agent, directly or through
// its store, and waits for its exec_result.
func (s *server) request(key string, m proto.Msg, wait time.Duration) (proto.Msg, error) {
	m.Req = randID()
	ch := s.hub.ExpectExec(key, m.Req)
	defer s.hub.DropExec(m.Req)
	if err := s.hub.Send(key, m); err != nil {
		return proto.Msg{}, err
	}
	select {
	case res := <-ch:
		return res, nil
	case <-time.After(wait):
		return proto.Msg{}, errors.New("no response from agent")
	}
}

// execOne runs a command on one agent (directly or through its store).
func (s *server) execOne(key, cmd string, timeout int) execResult {
	start := time.Now()
	res := execResult{ID: key}
	m, err := s.request(key, proto.Msg{Type: proto.TypeExec, Cmd: cmd, Timeout: timeout}, time.Duration(timeout+15)*time.Second)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.OK = m.Error == ""
	res.Code, res.Output, res.Error = m.Code, m.Output, m.Error
	res.Millis = time.Since(start).Milliseconds()
	return res
}

// openAgentSession asks an agent (directly or through its store) to dial back
// a session socket for m (open: a shell; log_download: a log archive).
func (s *server) openAgentSession(key string, m proto.Msg) (*wsConn, error) {
	sid := randID()
	ch := s.hub.ExpectSession(sid)
	defer s.hub.DropSession(sid)
	m.Session = sid
	if err := s.hub.Send(key, m); err != nil {
		return nil, err
	}
	select {
	case c := <-ch:
		return &wsConn{Conn: c}, nil
	case <-time.After(20 * time.Second):
		return nil, errors.New("agent did not open the session in time")
	}
}

// handleTerm bridges a browser WebSocket to a fresh shell on the agent.
func (s *server) handleTerm(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	key := q.Get("agent")
	cols, _ := strconv.Atoi(q.Get("cols"))
	rows, _ := strconv.Atoi(q.Get("rows"))
	if cols <= 0 || cols > 1000 {
		cols = 80
	}
	if rows <= 0 || rows > 1000 {
		rows = 24
	}

	bc, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	browser := &wsConn{Conn: bc}
	defer browser.Close()

	agentSide, err := s.openAgentSession(key, proto.Msg{Type: proto.TypeOpen, Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		browser.WriteJSON(proto.Msg{Type: proto.TypeError, Error: err.Error()})
		browser.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
		return
	}
	defer agentSide.Close()

	user := s.currentUser(r)
	start := time.Now()
	tag := randID()[:8]
	log.Printf("session open  id=%s agent=%s user=%q from=%s", tag, key, user, r.RemoteAddr)
	s.hub.sessionDelta(key, +1)
	defer func() {
		s.hub.sessionDelta(key, -1)
		log.Printf("session close id=%s agent=%s user=%q after=%s", tag, key, user, time.Since(start).Round(time.Second))
	}()
	splice(browser, agentSide)
}

// handleVNCCheck reports whether the POS VNC server is reachable, so the UI can
// explain a failure before the VNC client connects.
func (s *server) handleVNCCheck(w http.ResponseWriter, r *http.Request) {
	res, err := s.request(r.URL.Query().Get("agent"), proto.Msg{Type: proto.TypeVNCCheck}, 15*time.Second)
	if err == nil && res.Error != "" {
		err = errors.New(res.Error)
	}
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleVNC bridges the browser's VNC client (noVNC) to the POS VNC server.
func (s *server) handleVNC(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("agent")
	bc, err := vncUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	browser := &wsConn{Conn: bc}
	defer browser.Close()

	agentSide, err := s.openAgentSession(key, proto.Msg{Type: proto.TypeVNC})
	if err != nil {
		browser.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4000, truncate(err.Error(), 120)), time.Now().Add(time.Second))
		return
	}
	defer agentSide.Close()

	user := s.currentUser(r)
	start := time.Now()
	tag := randID()[:8]
	log.Printf("vnc open  id=%s agent=%s user=%q from=%s", tag, key, user, r.RemoteAddr)
	s.hub.sessionDelta(key, +1)
	defer func() {
		s.hub.sessionDelta(key, -1)
		log.Printf("vnc close id=%s agent=%s user=%q after=%s", tag, key, user, time.Since(start).Round(time.Second))
	}()
	splice(browser, agentSide)
}

// vncUpgrader also accepts the "binary" subprotocol older VNC clients ask for.
var vncUpgrader = websocket.Upgrader{ReadBufferSize: 64 << 10, WriteBufferSize: 64 << 10, Subprotocols: []string{"binary"}}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// handleLogList returns the log files an agent can send.
func (s *server) handleLogList(w http.ResponseWriter, r *http.Request) {
	res, err := s.request(r.URL.Query().Get("agent"), proto.Msg{Type: proto.TypeLogList}, 30*time.Second)
	if err == nil && res.Error != "" {
		err = errors.New(res.Error)
	}
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, res.Output)
}

// handleLogDownload streams the chosen log files of an agent as a .tar.gz.
func (s *server) handleLogDownload(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	key, files := q.Get("agent"), q["f"]
	if q.Get("all") == "1" {
		res, err := s.request(key, proto.Msg{Type: proto.TypeLogList}, 30*time.Second)
		var list []proto.LogFile
		if err == nil {
			err = json.Unmarshal([]byte(res.Output), &list)
		}
		if err != nil {
			httpError(w, http.StatusBadGateway, err.Error())
			return
		}
		for _, f := range list {
			files = append(files, f.Path)
		}
	}
	if len(files) == 0 {
		httpError(w, http.StatusBadRequest, "no files selected")
		return
	}

	agentSide, err := s.openAgentSession(key, proto.Msg{Type: proto.TypeLogDownload, Files: files})
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	defer agentSide.Close()
	done := make(chan struct{})
	defer close(done)
	keepalive(agentSide.Conn, done, nil)

	start := time.Now()
	var sent int64
	for {
		mt, data, err := agentSide.ReadMessage()
		if err != nil {
			break // normal close = end of archive
		}
		agentSide.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
		if mt == websocket.TextMessage {
			var m proto.Msg
			json.Unmarshal(data, &m)
			if sent == 0 {
				httpError(w, http.StatusBadGateway, m.Error)
				return
			}
			continue
		}
		if sent == 0 {
			name := fmt.Sprintf("%s-logs-%s.tar.gz", strings.ReplaceAll(key, "/", "_"), time.Now().Format("20060102-150405"))
			w.Header().Set("Content-Type", "application/gzip")
			w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
			w.Header().Set("Cache-Control", "no-store")
		}
		if _, err := w.Write(data); err != nil {
			break
		}
		sent += int64(len(data))
	}
	if sent == 0 {
		httpError(w, http.StatusBadGateway, "the agent sent no data")
	}
	log.Printf("logs download agent=%s files=%d bytes=%d user=%q from=%s after=%s", key, len(files), sent, s.currentUser(r), r.RemoteAddr, time.Since(start).Round(time.Millisecond))
}

// splice copies messages both ways until either side goes away.
func splice(a, b *wsConn) {
	done := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(done) }) }
	keepalive(a.Conn, done, nil)
	keepalive(b.Conn, done, nil)
	pump := func(src, dst *wsConn) {
		defer stop()
		for {
			mt, data, err := src.ReadMessage()
			if err != nil {
				return
			}
			src.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
			if err := dst.WriteMessage(mt, data); err != nil {
				return
			}
		}
	}
	go pump(a, b)
	go pump(b, a)
	<-done
	closeMsg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "")
	a.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))
	b.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))
}

// ---- agent & store endpoints -----------------------------------------------

func (s *server) tokenAuthed(token string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !tokenEqual(tok, token) {
			log.Printf("token auth failed path=%s from=%s", r.URL.Path, r.RemoteAddr)
			httpError(w, http.StatusUnauthorized, "bad token")
			return
		}
		h(w, r)
	}
}

// readHello upgrades a lower-tier control connection and reads its hello.
func readHello(w http.ResponseWriter, r *http.Request) (*wsConn, proto.Msg, bool) {
	raw, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil, proto.Msg{}, false
	}
	c := &wsConn{Conn: raw}
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	var hello proto.Msg
	if err := c.ReadJSON(&hello); err != nil || hello.Type != proto.TypeHello || !validID.MatchString(hello.ID) {
		log.Printf("from=%s: bad hello (%v)", r.RemoteAddr, err)
		c.Close()
		return nil, hello, false
	}
	return c, hello, true
}

func (s *server) handleAgentConnect(w http.ResponseWriter, r *http.Request) {
	c, hello, ok := readHello(w, r)
	if !ok {
		return
	}
	defer c.Close()
	s.hub.Register(hello, r.RemoteAddr, c)
	log.Printf("agent online  id=%s host=%s device=%s ver=%s from=%s", hello.ID, hello.Hostname, hello.DeviceID, hello.Version, r.RemoteAddr)
	if s.namesKick != nil && s.hub.NeedDeviceName(hello.DeviceID) {
		s.kickNames()
	}
	defer func() {
		s.hub.Unregister(hello.ID, c)
		log.Printf("agent offline id=%s", hello.ID)
	}()

	done := make(chan struct{})
	defer close(done)
	keepalive(c.Conn, done, func() { s.hub.Touch(hello.ID) })
	for {
		var m proto.Msg
		if err := c.ReadJSON(&m); err != nil {
			return
		}
		c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
		switch m.Type {
		case proto.TypeExecResult:
			s.hub.DeliverExec("agent:"+hello.ID, m)
		case proto.TypeStats:
			s.hub.SetAgentStats(hello.ID, m.Stats)
		}
	}
}

func (s *server) handleStoreConnect(w http.ResponseWriter, r *http.Request) {
	c, hello, ok := readHello(w, r)
	if !ok {
		return
	}
	c.Conn.SetReadLimit(64 << 20) // agent snapshots of large stores
	defer c.Close()
	s.hub.RegisterStore(hello, r.RemoteAddr, c)
	log.Printf("store online  id=%s host=%s ver=%s from=%s", hello.ID, hello.Hostname, hello.Version, r.RemoteAddr)
	if !s.hub.StoreHasName(hello.ID) {
		s.kickNames()
	}
	defer func() {
		s.hub.UnregisterStore(hello.ID, c)
		log.Printf("store offline id=%s", hello.ID)
	}()

	done := make(chan struct{})
	defer close(done)
	keepalive(c.Conn, done, func() { s.hub.TouchStore(hello.ID) })
	for {
		var m proto.Msg
		if err := c.ReadJSON(&m); err != nil {
			return
		}
		c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
		switch m.Type {
		case proto.TypeAgents:
			s.hub.UpdateStoreAgents(hello.ID, m.Agents, m.Stats)
			for _, a := range m.Agents {
				if s.namesKick != nil && s.hub.NeedDeviceName(a.DeviceID) {
					s.kickNames()
				}
			}
		case proto.TypeExecResult:
			s.hub.DeliverExec("store:"+hello.ID, m)
		}
	}
}

// handleSessionDialBack accepts the session socket an agent or store opens for a requested terminal.
func (s *server) handleSessionDialBack(w http.ResponseWriter, r *http.Request) {
	sid := r.URL.Query().Get("sid")
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	if !s.hub.DeliverSession(sid, c) {
		c.Close()
	}
}

// ---- helpers ---------------------------------------------------------------

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
