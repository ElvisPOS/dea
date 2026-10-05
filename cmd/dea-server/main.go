// dea-server is the central hub: POS agents dial in over WebSocket and
// operators open their terminals from a browser.
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"dea/internal/proto"
	"dea/internal/sysstat"
)

type config struct {
	Listen        string
	DataDir       string
	AgentToken    string
	AdminUser     string
	AdminPassword string
	SessionSecret []byte
	AllowNets     []*net.IPNet

	// Central side: token store servers present on /api/store/*.
	StoreToken string

	// Store side: link this server to a central server. A store server is one
	// with STORE_REPLICATION_ID and REPLICATION_SERVER_ADDRESS in its ElvisPOS
	// settings: dea links to the central it replicates from.
	Upstream      string // ws://<REPLICATION_SERVER_ADDRESS>:7681
	UpstreamToken string
	StoreID       string // STORE_REPLICATION_ID

	// Disks whose usage this server reports for its host (DEA_DISKS).
	Disks []sysstat.Probe
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	cfg := config{
		Listen:        env("DEA_LISTEN", ":"+deaPort),
		DataDir:       env("DEA_DATA", "./data"),
		AgentToken:    os.Getenv("DEA_AGENT_TOKEN"),
		AdminUser:     env("DEA_ADMIN_USER", "admin"),
		AdminPassword: os.Getenv("DEA_ADMIN_PASSWORD"),
		StoreToken:    os.Getenv("DEA_STORE_TOKEN"),
		UpstreamToken: os.Getenv("DEA_UPSTREAM_TOKEN"),
		Disks:         sysstat.ParseProbes(os.Getenv("DEA_DISKS")),
	}
	if len(cfg.AgentToken) < 16 {
		log.Fatal("DEA_AGENT_TOKEN must be set (at least 16 characters)")
	}
	if cfg.AdminPassword == "" {
		log.Fatal("DEA_ADMIN_PASSWORD must be set")
	}
	if s := os.Getenv("DEA_SESSION_SECRET"); s != "" {
		cfg.SessionSecret = []byte(s)
	} else {
		cfg.SessionSecret = make([]byte, 32)
		rand.Read(cfg.SessionSecret)
		log.Print("DEA_SESSION_SECRET not set: browser logins will not survive a restart")
	}
	if cfg.StoreToken != "" && len(cfg.StoreToken) < 16 {
		log.Fatal("DEA_STORE_TOKEN must be at least 16 characters")
	}
	storeID, central := strings.TrimSpace(os.Getenv("STORE_REPLICATION_ID")), os.Getenv("REPLICATION_SERVER_ADDRESS")
	switch {
	case storeID != "" && central != "":
		cfg.StoreID, cfg.Upstream = storeID, upstreamURL(central)
		if cfg.UpstreamToken == "" || !validID.MatchString(cfg.StoreID) || cfg.Upstream == "" {
			log.Fatal("store server: needs DEA_UPSTREAM_TOKEN, a STORE_REPLICATION_ID of letters, digits, . _ - and a REPLICATION_SERVER_ADDRESS")
		}
	case storeID != "" || central != "":
		log.Print("only one of STORE_REPLICATION_ID and REPLICATION_SERVER_ADDRESS is set: running as central, not linked to any server")
	}
	for _, c := range strings.Split(os.Getenv("DEA_ALLOW_CIDRS"), ",") {
		if c = strings.TrimSpace(c); c == "" {
			continue
		}
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			log.Fatalf("DEA_ALLOW_CIDRS: %v", err)
		}
		cfg.AllowNets = append(cfg.AllowNets, n)
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		log.Fatal(err)
	}

	s := &server{cfg: cfg, hub: NewHub(cfg.DataDir)}
	if cfg.Upstream != "" {
		go s.runUpstream()
	}
	s.namesKick = make(chan struct{}, 1)
	go s.runNames()
	go s.runSelfStats()
	if len(cfg.AllowNets) > 0 {
		log.Printf("accepting connections only from %s", os.Getenv("DEA_ALLOW_CIDRS"))
	}
	log.Printf("dea-server %s listening on %s", version, cfg.Listen)
	srv := &http.Server{Addr: cfg.Listen, Handler: s.allowlist(s.routes()), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

var version = "dev"

// deaPort is where every dea server listens, and so where a store finds central.
const deaPort = "7681"

// upstreamURL turns REPLICATION_SERVER_ADDRESS (a host or IP, possibly with a
// scheme, port or path) into central's dea address.
func upstreamURL(addr string) string {
	addr = strings.TrimSpace(addr)
	if i := strings.Index(addr, "://"); i >= 0 {
		addr = addr[i+3:]
	}
	addr, _, _ = strings.Cut(addr, "/")
	host := addr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host == "" {
		return ""
	}
	return "ws://" + net.JoinHostPort(host, deaPort)
}

// allowlist rejects clients outside DEA_ALLOW_CIDRS (if set).
func (s *server) allowlist(next http.Handler) http.Handler {
	if len(s.cfg.AllowNets) == 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host)
		for _, n := range s.cfg.AllowNets {
			if ip != nil && n.Contains(ip) {
				next.ServeHTTP(w, r)
				return
			}
		}
		log.Printf("rejected %s %s from %s (not in DEA_ALLOW_CIDRS)", r.Method, r.URL.Path, r.RemoteAddr)
		http.Error(w, "forbidden", http.StatusForbidden)
	})
}

func randID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func tokenEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// upgrader rejects cross-origin browser requests (gorilla's default origin check);
// agents send no Origin header and are allowed through to token auth.
var upgrader = websocket.Upgrader{ReadBufferSize: 32 << 10, WriteBufferSize: 32 << 10}

// wsConn serialises writes on a websocket.Conn (gorilla allows one concurrent writer).
type wsConn struct {
	*websocket.Conn
	wmu sync.Mutex
}

func (c *wsConn) WriteJSON(v any) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.SetWriteDeadline(time.Now().Add(proto.WriteTimeout))
	return c.Conn.WriteJSON(v)
}

func (c *wsConn) WriteMessage(mt int, data []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.SetWriteDeadline(time.Now().Add(proto.WriteTimeout))
	return c.Conn.WriteMessage(mt, data)
}

// keepalive installs a pong handler that extends the read deadline (calling
// onPong if set) and pings the peer until done is closed. Call it before
// starting the reader so the handler is in place.
func keepalive(c *websocket.Conn, done <-chan struct{}, onPong func()) {
	c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
	c.SetPongHandler(func(string) error {
		if onPong != nil {
			onPong()
		}
		return c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
	})
	go func() {
		t := time.NewTicker(proto.PingInterval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if err := c.WriteControl(websocket.PingMessage, nil, time.Now().Add(proto.WriteTimeout)); err != nil {
					return
				}
			}
		}
	}()
}
