// Package proto defines the JSON messages exchanged between rterm nodes.
//
// Topology: POS agents connect to a server (usually the store server); a store
// server may in turn connect "upstream" to a central server. Every link is
// opened by the lower tier, so nothing ever needs inbound access to a POS or
// a store.
//
// Each link has one long-lived "control" WebSocket. For every terminal the
// upper tier asks the lower tier to dial back a separate "session" WebSocket
// carrying the given session id; the hops are then spliced 1:1 all the way
// from the browser to the POS shell. On session sockets binary frames carry
// raw terminal bytes and text frames carry JSON control messages.
package proto

import "time"

const (
	// Control channel, lower -> upper tier.
	TypeHello      = "hello"
	TypeExecResult = "exec_result"
	TypeAgents     = "agents" // store -> central: snapshot of the store's agents

	// Control channel, upper -> lower tier.
	TypeOpen        = "open"
	TypeExec        = "exec"
	TypeForget      = "forget"       // central -> store: drop an offline agent
	TypeLogList     = "log_list"     // answered with exec_result, Output = JSON []LogFile
	TypeLogDownload = "log_download" // like open: the agent dials back a session and streams a .tar.gz of Files
	TypeVNC         = "vnc"          // like open: the agent dials back a session bridged to the POS VNC server
	TypeVNCCheck    = "vnc_check"    // answered with exec_result; Error set when VNC is not reachable

	// Session channel.
	TypeResize = "resize" // browser -> agent
	TypeExit   = "exit"   // agent -> browser
	TypeError  = "error"  // any hop -> browser
)

// Msg is the single envelope used for every JSON message; unused fields are omitted.
type Msg struct {
	Type string `json:"type"`

	// hello
	ID       string   `json:"id,omitempty"`
	Hostname string   `json:"hostname,omitempty"`
	OS       string   `json:"os,omitempty"`
	Arch     string   `json:"arch,omitempty"`
	User     string   `json:"user,omitempty"`
	Version  string   `json:"version,omitempty"`
	IPs      []string `json:"ips,omitempty"`
	DeviceID string   `json:"device_id,omitempty"` // agent hello: ELVIS_DEVICE_ID of the POS

	// Routing on store links: the target agent, relative to the receiving store.
	Agent string `json:"agent,omitempty"`

	// open / resize
	Session string `json:"session,omitempty"`
	Cols    uint16 `json:"cols,omitempty"`
	Rows    uint16 `json:"rows,omitempty"`

	// exec / exec_result
	Req     string `json:"req,omitempty"`
	Cmd     string `json:"cmd,omitempty"`
	Timeout int    `json:"timeout,omitempty"` // seconds
	Output  string `json:"output,omitempty"`
	Code    int    `json:"code"`
	Error   string `json:"error,omitempty"`

	// agents
	Agents []AgentInfo `json:"agents,omitempty"`

	// log_download: absolute paths, as listed by log_list
	Files []string `json:"files,omitempty"`
}

// LogFile is one entry of a log_list answer.
type LogFile struct {
	Path    string    `json:"path"` // absolute path on the POS
	Name    string    `json:"name"` // path relative to /usr/share/elvispos, e.g. client_agent/log/elvis-CLIENT0.log
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mtime"`
}

// AgentInfo describes one POS agent as seen by a server.
type AgentInfo struct {
	ID          string    `json:"id"`    // agent's own id (usually its hostname)
	Store       string    `json:"store"` // path of stores it is reached through ("" = direct)
	Hostname    string    `json:"hostname"`
	DeviceID    string    `json:"device_id,omitempty"` // ELVIS_DEVICE_ID, key of system.devices
	Name        string    `json:"name,omitempty"`      // system.devices description, when known
	OS          string    `json:"os"`
	Arch        string    `json:"arch"`
	User        string    `json:"user"`
	Version     string    `json:"version"`
	IPs         []string  `json:"ips"`
	RemoteAddr  string    `json:"remote_addr"`
	FirstSeen   time.Time `json:"first_seen"`
	LastSeen    time.Time `json:"last_seen"`
	ConnectedAt time.Time `json:"connected_at,omitempty"`
	Online      bool      `json:"online"`
	Sessions    int       `json:"sessions"`
}

// Key is the agent's unique address on the server that produced this info.
func (a AgentInfo) Key() string {
	if a.Store == "" {
		return a.ID
	}
	return a.Store + "/" + a.ID
}

const (
	PingInterval = 25 * time.Second
	ReadTimeout  = 70 * time.Second
	WriteTimeout = 10 * time.Second

	// MaxExecOutput caps the output returned by a one-shot command.
	MaxExecOutput = 256 << 10
)
