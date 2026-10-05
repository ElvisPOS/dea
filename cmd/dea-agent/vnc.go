package main

import (
	"log"
	"net"
	"time"

	"github.com/gorilla/websocket"

	"dea/internal/proto"
)

// The POS screen is served by x11vnc on port 5900. The agent connects to it
// locally and bridges the bytes to a session socket, so the browser's VNC
// client talks to it through the same outbound chain as the terminals. VNC
// authentication stays end to end between the browser and x11vnc.
const vncAddr = "127.0.0.1:5900"

const errNoVNC = "VNC is not running on this POS"

func (a *agent) vncCheckResult() proto.Msg {
	c, err := net.DialTimeout("tcp", vncAddr, 3*time.Second)
	if err != nil {
		return proto.Msg{Error: errNoVNC}
	}
	c.Close()
	return proto.Msg{}
}

func (a *agent) vncSession(m proto.Msg) {
	raw, err := a.dial("/api/agent/session?sid=" + m.Session)
	if err != nil {
		log.Printf("vnc %.8s: dial: %v", m.Session, err)
		return
	}
	c := &conn{Conn: raw}
	defer c.Close()

	tcp, err := net.DialTimeout("tcp", vncAddr, 5*time.Second)
	if err != nil {
		c.send(proto.Msg{Type: proto.TypeError, Error: errNoVNC})
		return
	}
	defer tcp.Close()
	start := time.Now()
	log.Printf("vnc %.8s: connected to %s", m.Session, vncAddr)

	// VNC server -> browser
	go func() {
		buf := make([]byte, 64<<10)
		for {
			n, err := tcp.Read(buf)
			if n > 0 && c.sendBinary(buf[:n]) != nil {
				break
			}
			if err != nil {
				break
			}
		}
		c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
		c.Close()
	}()

	// browser -> VNC server
	watchDeadline(c.Conn)
	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			break
		}
		c.SetReadDeadline(time.Now().Add(proto.ReadTimeout))
		if mt == websocket.BinaryMessage {
			if _, err := tcp.Write(data); err != nil {
				break
			}
		}
	}
	log.Printf("vnc %.8s: closed after %s", m.Session, time.Since(start).Round(time.Second))
}
