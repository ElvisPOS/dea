// rterm-server is the central hub: POS agents dial in over WebSocket and
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

	"rterm/internal/proto"
)

type config struct {
	Listen        string
	DataDir       string
	AgentToken    string
	AdminUser     string
	AdminPassword string
	SessionSecret []byte
	PublicURL     string
	AllowNets     []*net.IPNet

	// Central side: token store servers present on /api/store/*.
	StoreToken string

	// Store side: link this server to a central server.
	Upstream      string
	UpstreamToken string
	StoreID       string

	// ybservice base URL used to read store and POS names (system.store, system.devices).
	YBServiceURL string
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	cfg := config{
		Listen:        env("RTERM_LISTEN", ":7681"),
		DataDir:       env("RTERM_DATA", "./data"),
		AgentToken:    os.Getenv("RTERM_AGENT_TOKEN"),
		AdminUser:     env("RTERM_ADMIN_USER", "admin"),
		AdminPassword: os.Getenv("RTERM_ADMIN_PASSWORD"),
		PublicURL:     strings.TrimRight(os.Getenv("RTERM_PUBLIC_URL"), "/"),
		StoreToken:    os.Getenv("RTERM_STORE_TOKEN"),
		Upstream:      strings.TrimRight(os.Getenv("RTERM_UPSTREAM"), "/"),
		UpstreamToken: os.Getenv("RTERM_UPSTREAM_TOKEN"),
		StoreID:       os.Getenv("RTERM_STORE_ID"),
		YBServiceURL:  strings.TrimRight(os.Getenv("RTERM_YBSERVICE_URL"), "/"),
	}
	if len(cfg.AgentToken) < 16 {
		log.Fatal("RTERM_AGENT_TOKEN must be set (at least 16 characters)")
	}
	if cfg.AdminPassword == "" {
		log.Fatal("RTERM_ADMIN_PASSWORD must be set")
	}
	if s := os.Getenv("RTERM_SESSION_SECRET"); s != "" {
		cfg.SessionSecret = []byte(s)
	} else {
		cfg.SessionSecret = make([]byte, 32)
		rand.Read(cfg.SessionSecret)
		log.Print("RTERM_SESSION_SECRET not set: browser logins will not survive a restart")
	}
	if cfg.StoreToken != "" && len(cfg.StoreToken) < 16 {
		log.Fatal("RTERM_STORE_TOKEN must be at least 16 characters")
	}
	if cfg.Upstream != "" && (cfg.UpstreamToken == "" || !validID.MatchString(cfg.StoreID)) {
		log.Fatal("RTERM_UPSTREAM needs RTERM_UPSTREAM_TOKEN and RTERM_STORE_ID (letters, digits, . _ -)")
	}
	for _, c := range strings.Split(os.Getenv("RTERM_ALLOW_CIDRS"), ",") {
		if c = strings.TrimSpace(c); c == "" {
			continue
		}
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			log.Fatalf("RTERM_ALLOW_CIDRS: %v", err)
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
	if cfg.YBServiceURL != "" {
		s.namesKick = make(chan struct{}, 1)
		go s.runNames()
	}
	if len(cfg.AllowNets) > 0 {
		log.Printf("accepting connections only from %s", os.Getenv("RTERM_ALLOW_CIDRS"))
	}
	log.Printf("rterm-server %s listening on %s", version, cfg.Listen)
	srv := &http.Server{Addr: cfg.Listen, Handler: s.allowlist(s.routes()), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}

var version = "dev"

// allowlist rejects clients outside RTERM_ALLOW_CIDRS (if set).
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
		log.Printf("rejected %s %s from %s (not in RTERM_ALLOW_CIDRS)", r.Method, r.URL.Path, r.RemoteAddr)
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
