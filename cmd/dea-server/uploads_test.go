package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestUploadAuditRecordsEveryEvent(t *testing.T) {
	var buf bytes.Buffer
	uploadLog = &buf
	defer func() { uploadLog = nil }()

	u := newUploadAudit("central-1", "12/memphis-pos-169", "admin", "10.8.0.5", "b4e5e5c3")
	text := func(down bool, s string) { u.frame(down, websocket.TextMessage, []byte(s)) }
	bin := func(n int) { u.frame(true, websocket.BinaryMessage, make([]byte, n)) }

	// a file that exists, replaced after the user agrees
	text(true, `{"type":"upload","name":"price.csv","size":10}`)
	text(false, `{"type":"upload_error","name":"price.csv","path":"/tmp/price.csv","exists":true}`)
	text(true, `{"type":"upload","name":"price.csv","size":10,"overwrite":true}`)
	text(false, `{"type":"upload_ready","name":"price.csv","path":"/tmp/price.csv"}`)
	bin(6)
	u.frame(true, websocket.TextMessage, []byte(`{"type":"resize","cols":80,"rows":24}`)) // not an upload event
	bin(4)
	text(false, `{"type":"upload_done","name":"price.csv","path":"/tmp/price.csv","size":10,"sha256":"abc","replaced":true,"old_size":7}`)
	// refused, then one cut off by the terminal closing
	text(true, `{"type":"upload","name":"x","size":1}`)
	text(false, `{"type":"upload_error","name":"x","error":"no permission to write in /usr/bin"}`)
	text(true, `{"type":"upload","name":"big.bin","size":100}`)
	text(false, `{"type":"upload_ready","name":"big.bin","path":"/tmp/big.bin"}`)
	bin(30)
	u.close()

	var got []uploadEvent
	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		var e uploadEvent
		if err := json.Unmarshal([]byte(l), &e); err != nil {
			t.Fatal(err, l)
		}
		got = append(got, e)
	}
	want := []string{"requested", "exists", "requested", "started", "saved", "requested", "refused", "requested", "started", "interrupted"}
	if len(got) != len(want) {
		t.Fatalf("got %d events, want %d: %s", len(got), len(want), buf.String())
	}
	for i, w := range want {
		if got[i].Event != w {
			t.Errorf("event %d: %s, want %s", i, got[i].Event, w)
		}
		if got[i].User != "admin" || got[i].From != "10.8.0.5" || got[i].Agent != "12/memphis-pos-169" || got[i].Server != "central-1" {
			t.Errorf("event %d lacks who/where: %+v", i, got[i])
		}
	}
	if s := got[4]; s.Bytes != 10 || s.SHA256 != "abc" || !s.Replaced || s.OldSize != 7 || s.Path != "/tmp/price.csv" || !s.Overwrite {
		t.Errorf("saved: %+v", s)
	}
	if got[6].Error != "no permission to write in /usr/bin" {
		t.Errorf("refused: %+v", got[6])
	}
	if got[9].Bytes != 30 || got[9].Path != "/tmp/big.bin" {
		t.Errorf("interrupted: %+v", got[9])
	}
}
