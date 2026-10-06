package main

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"dea/internal/proto"
)

var errOffline = errors.New("agent is offline")

// StoreInfo is what we know (and persist) about a downstream store server.
type StoreInfo struct {
	ID          string       `json:"id"`
	Name        string       `json:"name,omitempty"` // from system.store, when central knows it
	Hostname    string       `json:"hostname"`
	Version     string       `json:"version"`
	RemoteAddr  string       `json:"remote_addr"`
	FirstSeen   time.Time    `json:"first_seen"`
	LastSeen    time.Time    `json:"last_seen"`
	ConnectedAt time.Time    `json:"connected_at,omitempty"`
	Online      bool         `json:"online"`
	Stats       *proto.Stats `json:"stats,omitempty"` // the store server's own resource usage
}

// agent is a POS reachable either directly (conn) or through a store (via).
type agent struct {
	info     proto.AgentInfo
	conn     *wsConn // direct agents: nil while offline
	via      string  // routed agents: id of the store we reach it through
	sessions int     // direct agents: sessions opened through this server
}

type store struct {
	info StoreInfo
	conn *wsConn
}

type execWait struct {
	route string // "agent:<key>" or "store:<id>": the link the result must arrive on
	ch    chan proto.Msg
}

// Hub tracks agents and stores, pending terminal sessions and in-flight exec requests.
type Hub struct {
	open     atomic.Int32 // sessions spliced through this server (terminals, screens, relays)
	mu       sync.Mutex
	agents   map[string]*agent // by key: "pos" or "store/pos"
	stores   map[string]*store
	sessions map[string]chan *websocket.Conn // sid -> waiting browser/upstream handler
	execs    map[string]execWait             // req id -> waiting exec handler
	names    map[string]string               // store id -> name, last fetched
	devices  map[string]string               // device id -> system.devices description
	asked    map[string]bool                 // device ids a refresh was already requested for
	dirty    bool
	path     string
}

type savedState struct {
	Agents []proto.AgentInfo `json:"agents"`
	Stores []StoreInfo       `json:"stores"`
}

func NewHub(dataDir string) *Hub {
	h := &Hub{
		agents:   map[string]*agent{},
		stores:   map[string]*store{},
		sessions: map[string]chan *websocket.Conn{},
		execs:    map[string]execWait{},
		path:     filepath.Join(dataDir, "agents.json"),
	}
	h.load()
	go h.saveLoop()
	return h
}

func (h *Hub) load() {
	b, err := os.ReadFile(h.path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("load %s: %v", h.path, err)
		}
		return
	}
	var st savedState
	if err := json.Unmarshal(b, &st); err != nil {
		// v1 format: a plain array of direct agents.
		if err2 := json.Unmarshal(b, &st.Agents); err2 != nil {
			log.Printf("parse %s: %v", h.path, err)
			return
		}
	}
	for _, s := range st.Stores {
		s.Online, s.ConnectedAt = false, time.Time{}
		h.stores[s.ID] = &store{info: s}
	}
	for _, in := range st.Agents {
		in.Online, in.Sessions, in.ConnectedAt = false, 0, time.Time{}
		a := &agent{info: in}
		if in.Store != "" {
			a.via, _, _ = strings.Cut(in.Store, "/")
			if h.stores[a.via] == nil {
				continue
			}
		}
		h.agents[in.Key()] = a
	}
	log.Printf("loaded %d agents, %d stores", len(h.agents), len(h.stores))
}

// saveLoop writes the registry at most every few seconds, so thousands of agents
// reconnecting at once don't each trigger a full rewrite.
func (h *Hub) saveLoop() {
	for range time.Tick(3 * time.Second) {
		h.mu.Lock()
		if !h.dirty {
			h.mu.Unlock()
			continue
		}
		var st savedState
		for _, a := range h.agents {
			st.Agents = append(st.Agents, a.info)
		}
		for _, s := range h.stores {
			st.Stores = append(st.Stores, s.info)
		}
		h.dirty = false
		h.mu.Unlock()

		b, _ := json.MarshalIndent(st, "", "  ")
		tmp := h.path + ".tmp"
		if err := os.WriteFile(tmp, b, 0o600); err != nil {
			log.Printf("save agents: %v", err)
			continue
		}
		if err := os.Rename(tmp, h.path); err != nil {
			log.Printf("save agents: %v", err)
		}
	}
}

// ---- direct agents ---------------------------------------------------------

// Register marks a direct agent online. A previous connection with the same ID is closed.
func (h *Hub) Register(hello proto.Msg, remote string, c *wsConn) {
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	a, ok := h.agents[hello.ID]
	if !ok {
		a = &agent{info: proto.AgentInfo{ID: hello.ID, FirstSeen: now}}
		h.agents[hello.ID] = a
	}
	if a.conn != nil {
		log.Printf("agent %s: replacing existing connection from %s (duplicate id?)", hello.ID, a.info.RemoteAddr)
		a.conn.Close()
	}
	a.conn = c
	in := &a.info
	in.Hostname, in.OS, in.Arch, in.User, in.Version, in.IPs = hello.Hostname, hello.OS, hello.Arch, hello.User, hello.Version, hello.IPs
	in.DeviceID = hello.DeviceID
	if name := h.devices[in.DeviceID]; name != "" {
		in.Name = name
	}
	in.RemoteAddr, in.LastSeen, in.ConnectedAt = remote, now, now
	h.dirty = true
}

// Unregister marks a direct agent offline, unless it has already reconnected on a newer connection.
func (h *Hub) Unregister(id string, c *wsConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if a, ok := h.agents[id]; ok && a.conn == c {
		a.conn = nil
		a.info.LastSeen = time.Now()
		a.info.ConnectedAt = time.Time{}
		h.dirty = true
	}
}

// Touch records that a direct agent or store answered a ping.
func (h *Hub) Touch(id string) {
	h.mu.Lock()
	if a, ok := h.agents[id]; ok && a.via == "" {
		a.info.LastSeen = time.Now()
	}
	h.mu.Unlock()
}

func (h *Hub) TouchStore(id string) {
	h.mu.Lock()
	if s, ok := h.stores[id]; ok {
		s.info.LastSeen = time.Now()
	}
	h.mu.Unlock()
}

// SetAgentStats records the latest resource report of a direct agent.
func (h *Hub) SetAgentStats(id string, st *proto.Stats) {
	h.mu.Lock()
	if a, ok := h.agents[id]; ok && a.via == "" && st != nil {
		a.info.Stats = st
	}
	h.mu.Unlock()
}

// ---- stores ----------------------------------------------------------------

func (h *Hub) RegisterStore(hello proto.Msg, remote string, c *wsConn) {
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.stores[hello.ID]
	if !ok {
		s = &store{info: StoreInfo{ID: hello.ID, FirstSeen: now}}
		h.stores[hello.ID] = s
	}
	if s.conn != nil {
		log.Printf("store %s: replacing existing connection from %s (duplicate id?)", hello.ID, s.info.RemoteAddr)
		s.conn.Close()
	}
	s.conn = c
	if name := h.names[hello.ID]; name != "" {
		s.info.Name = name
	}
	s.info.Hostname, s.info.Version = hello.Hostname, hello.Version
	s.info.RemoteAddr, s.info.LastSeen, s.info.ConnectedAt = remote, now, now
	h.dirty = true
}

func (h *Hub) UnregisterStore(id string, c *wsConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s, ok := h.stores[id]; ok && s.conn == c {
		s.conn = nil
		s.info.LastSeen = time.Now()
		s.info.ConnectedAt = time.Time{}
		h.dirty = true
	}
}

// SetStoreNames records the latest store names; stores missing from it keep their last known name.
func (h *Hub) SetStoreNames(names map[string]string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.names = names
	for id, s := range h.stores {
		if name := names[id]; name != "" && name != s.info.Name {
			s.info.Name = name
			h.dirty = true
		}
	}
}

// SetDeviceNames records system.devices descriptions; agents keep their last known name.
func (h *Hub) SetDeviceNames(names map[string]string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.devices = names
	for _, a := range h.agents {
		if name := names[a.info.DeviceID]; a.info.DeviceID != "" && name != "" && name != a.info.Name {
			a.info.Name = name
			h.dirty = true
		}
	}
}

// NeedDeviceName reports, once per id, that a device has no known description,
// so a refresh is requested for each new id but not over and over.
func (h *Hub) NeedDeviceName(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if id == "" || h.devices[id] != "" || h.asked[id] {
		return false
	}
	if h.asked == nil {
		h.asked = map[string]bool{}
	}
	h.asked[id] = true
	return true
}

// StoreName is the system.store description of a store id, if known (a store
// server reads its own name from its local database).
func (h *Hub) StoreName(id string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.names[id]
}

// StoreHasName reports whether a name is known for the store.
func (h *Hub) StoreHasName(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.stores[id]
	return ok && s.info.Name != ""
}

// UpdateStoreAgents replaces everything we know about the agents behind a store
// with the store's latest snapshot, and records the store server's own usage.
func (h *Hub) UpdateStoreAgents(storeID string, list []proto.AgentInfo, st *proto.Stats) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s, ok := h.stores[storeID]; ok && st != nil {
		s.info.Stats = st
	}
	seen := map[string]bool{}
	for _, in := range list {
		if in.Store == "" {
			in.Store = storeID
		} else {
			in.Store = storeID + "/" + in.Store
		}
		key := in.Key()
		seen[key] = true
		if name := h.devices[in.DeviceID]; in.DeviceID != "" && name != "" {
			in.Name = name
		} else if old, ok := h.agents[key]; ok && in.Name == "" {
			in.Name = old.info.Name
		}
		h.agents[key] = &agent{info: in, via: storeID}
	}
	for key, a := range h.agents {
		if a.via == storeID && !seen[key] {
			delete(h.agents, key)
		}
	}
	h.dirty = true
}

// ---- queries ---------------------------------------------------------------

func (h *Hub) online(a *agent) bool {
	if a.via == "" {
		return a.conn != nil
	}
	s := h.stores[a.via]
	return s != nil && s.conn != nil && a.info.Online
}

// List returns all agents and all stores. An agent's address on this server is AgentInfo.Key().
func (h *Hub) List() ([]proto.AgentInfo, []StoreInfo) {
	h.mu.Lock()
	agents := make([]proto.AgentInfo, 0, len(h.agents))
	for _, a := range h.agents {
		in := a.info
		in.Online = h.online(a)
		if a.via == "" {
			in.Sessions = a.sessions
		} else if !in.Online {
			in.Sessions = 0
		}
		agents = append(agents, in)
	}
	stores := make([]StoreInfo, 0, len(h.stores))
	for _, s := range h.stores {
		in := s.info
		in.Online = s.conn != nil
		stores = append(stores, in)
	}
	h.mu.Unlock()
	sort.Slice(agents, func(i, j int) bool { return agents[i].Key() < agents[j].Key() })
	sort.Slice(stores, func(i, j int) bool { return stores[i].ID < stores[j].ID })
	return agents, stores
}

// ---- actions ---------------------------------------------------------------

// Forget removes an offline agent. Agents behind an online store are forgotten on that store.
func (h *Hub) Forget(key string) error {
	h.mu.Lock()
	a, ok := h.agents[key]
	if !ok {
		h.mu.Unlock()
		return errors.New("unknown agent")
	}
	if h.online(a) {
		h.mu.Unlock()
		return errors.New("agent is online")
	}
	var forward *wsConn
	if s := h.stores[a.via]; a.via != "" && s != nil && s.conn != nil {
		forward = s.conn
	} else {
		delete(h.agents, key)
		h.dirty = true
	}
	h.mu.Unlock()
	if forward != nil {
		return forward.WriteJSON(proto.Msg{Type: proto.TypeForget, Agent: strings.TrimPrefix(key, a.via+"/")})
	}
	return nil
}

// ForgetStore removes an offline store and the agents behind it.
func (h *Hub) ForgetStore(id string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.stores[id]
	if !ok {
		return errors.New("unknown store")
	}
	if s.conn != nil {
		return errors.New("store is online")
	}
	delete(h.stores, id)
	for key, a := range h.agents {
		if a.via == id {
			delete(h.agents, key)
		}
	}
	h.dirty = true
	return nil
}

// Send delivers a control message to an agent, through its store if needed.
func (h *Hub) Send(key string, m proto.Msg) error {
	h.mu.Lock()
	a, ok := h.agents[key]
	var c *wsConn
	if ok && h.online(a) {
		if a.via == "" {
			c = a.conn
		} else {
			c = h.stores[a.via].conn
			m.Agent = strings.TrimPrefix(key, a.via+"/")
		}
	}
	h.mu.Unlock()
	if c == nil {
		return errOffline
	}
	return c.WriteJSON(m)
}

// sessionDelta counts sessions on direct agents; stores report their own counts.
func (h *Hub) sessionDelta(key string, d int) {
	h.open.Add(int32(d))
	h.mu.Lock()
	if a, ok := h.agents[key]; ok && a.via == "" {
		a.sessions += d
	}
	h.mu.Unlock()
}

// ExpectSession registers a terminal session waiting for its downstream socket.
func (h *Hub) ExpectSession(sid string) chan *websocket.Conn {
	ch := make(chan *websocket.Conn, 1)
	h.mu.Lock()
	h.sessions[sid] = ch
	h.mu.Unlock()
	return ch
}

func (h *Hub) DropSession(sid string) {
	h.mu.Lock()
	delete(h.sessions, sid)
	h.mu.Unlock()
}

// DeliverSession hands a downstream session socket to the waiting handler.
func (h *Hub) DeliverSession(sid string, c *websocket.Conn) bool {
	h.mu.Lock()
	ch, ok := h.sessions[sid]
	delete(h.sessions, sid)
	h.mu.Unlock()
	if ok {
		ch <- c
	}
	return ok
}

func (h *Hub) ExpectExec(key, req string) chan proto.Msg {
	ch := make(chan proto.Msg, 1)
	h.mu.Lock()
	route := "agent:" + key
	if a, ok := h.agents[key]; ok && a.via != "" {
		route = "store:" + a.via
	}
	h.execs[req] = execWait{route, ch}
	h.mu.Unlock()
	return ch
}

func (h *Hub) DropExec(req string) {
	h.mu.Lock()
	delete(h.execs, req)
	h.mu.Unlock()
}

// DeliverExec routes an exec result, accepting it only from the link it was sent on:
// source is "agent:<id>" for a direct agent or "store:<id>" for a store.
func (h *Hub) DeliverExec(source string, m proto.Msg) {
	h.mu.Lock()
	w, ok := h.execs[m.Req]
	if ok && w.route == source {
		delete(h.execs, m.Req)
	} else {
		ok = false
	}
	h.mu.Unlock()
	if ok {
		w.ch <- m
	}
}
