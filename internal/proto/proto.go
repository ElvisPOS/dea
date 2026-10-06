// Package proto defines the JSON messages exchanged between dea nodes.
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
	TypeAgents     = "agents" // store -> central: snapshot of the store's agents (+ the store's own Stats)
	TypeStats      = "stats"  // agent -> server: resource usage of the POS, every StatsInterval

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

	// Session channel of a terminal: a file dropped on it, saved in the
	// terminal's current folder (see cmd/dea-agent/upload.go).
	TypeUpload         = "upload"          // browser -> agent: Name, Size, Overwrite; then Size bytes in binary frames
	TypeUploadReady    = "upload_ready"    // agent -> browser: Path; send the bytes
	TypeUploadProgress = "upload_progress" // agent -> browser: Size bytes saved so far
	TypeUploadDone     = "upload_done"     // agent -> browser: Path, Size
	TypeUploadError    = "upload_error"    // agent -> browser: Error, or Exists with Path
	TypeUploadCancel   = "upload_cancel"   // browser -> agent
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
	By      string `json:"by,omitempty"` // open: who asked for the session, "user@address" (agents log it with uploads)
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

	// upload*
	Name      string `json:"name,omitempty"`
	Size      int64  `json:"size,omitempty"`
	Overwrite bool   `json:"overwrite,omitempty"`
	Path      string `json:"path,omitempty"`
	Exists    bool   `json:"exists,omitempty"`
	SHA256    string `json:"sha256,omitempty"`   // upload_done: of the saved file
	Replaced  bool   `json:"replaced,omitempty"` // upload_done: an existing file was replaced
	OldSize   int64  `json:"old_size,omitempty"` // upload_done: size of the replaced file

	// stats (agent), agents (store): resource usage of the sending host
	Stats *Stats `json:"stats,omitempty"`
}

// StatsInterval is how often agents and servers sample their resource usage.
const StatsInterval = 60 * time.Second

// SnapshotInterval is the longest a store waits before resending its agent
// list (with the latest resource reports) to central.
const SnapshotInterval = 30 * time.Second

// Stats is a host's resource usage. Sizes are bytes.
type Stats struct {
	At        time.Time `json:"at"`
	CPUs      int       `json:"cpus"`
	CPU       float64   `json:"cpu"`  // % busy over the last interval, all cores together
	Load      []float64 `json:"load"` // 1, 5 and 15 minute load averages
	MemTotal  uint64    `json:"mem_total"`
	MemUsed   uint64    `json:"mem_used"` // total - available
	SwapTotal uint64    `json:"swap_total"`
	SwapUsed  uint64    `json:"swap_used"`
	Disks     []Disk    `json:"disks"`
	Uptime    int64     `json:"uptime"` // seconds since the host booted
}

// Disk is one filesystem; Used/(Used+Avail) is the "Use%" df shows.
type Disk struct {
	Path  string `json:"path"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Avail uint64 `json:"avail"`
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
	Stats       *Stats    `json:"stats,omitempty"` // last report; agents older than v1.6.0 send none
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
