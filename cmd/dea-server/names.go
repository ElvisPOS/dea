package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// Store and POS names come from system.store and system.devices, read through
// ybservice's free-query endpoint (command 1003 returns the rows as a JSON
// array). ybservice runs on every ElvisPOS server, on the network-backend the
// dea container joins. The last names fetched are kept, so the UI keeps them
// while ybservice is unreachable.

const (
	ybserviceURL     = "http://ybservice:7392"
	storeNamesQuery  = `SELECT n0_store_id AS id, sz_description AS name FROM system.store WHERE dt_deleted IS NULL`
	deviceNamesQuery = `SELECT n0_device_id AS id, sz_description AS name FROM system.devices`
	namesRefresh     = 5 * time.Minute
	namesMinGap      = 30 * time.Second // between refreshes asked for by unknown ids
	freeQueryJSON    = 1003             // RemoteLookupCommand.CMD_FREE_QUERY_JSONARRAY
)

func (s *server) runNames() {
	log.Printf("names: reading system.store and system.devices through %s", ybserviceURL)
	for {
		if names, err := s.freeQueryNames(storeNamesQuery); err != nil {
			log.Printf("names: stores: %v", err)
		} else {
			s.hub.SetStoreNames(names)
		}
		if names, err := s.freeQueryNames(deviceNamesQuery); err != nil {
			log.Printf("names: devices: %v", err)
		} else {
			s.hub.SetDeviceNames(names)
		}
		select {
		case <-s.namesKick:
			time.Sleep(namesMinGap) // let a burst of new ids settle and cap the query rate
		case <-time.After(namesRefresh):
		}
	}
}

// kickNames asks for a refresh soon, e.g. when a store or POS with no known name connects.
func (s *server) kickNames() {
	if s.namesKick == nil {
		return
	}
	select {
	case s.namesKick <- struct{}{}:
	default:
	}
}

// freeQueryNames runs an "id, name" query through ybservice.
func (s *server) freeQueryNames(query string) (map[string]string, error) {
	body, _ := json.Marshal(map[string]any{"request": map[string]any{"command": freeQueryJSON, "query": query}})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ybserviceURL+"/api/db-operations/remote-lookup", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("ybservice answered %s", resp.Status)
	}

	// errors come back as plain text such as "SQL ERROR"
	var rows []struct {
		ID   any    `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("unexpected answer from ybservice: %.80q", raw)
	}
	names := make(map[string]string, len(rows))
	for _, r := range rows {
		if name := strings.Join(strings.Fields(r.Name), " "); r.ID != nil && name != "" {
			names[fmt.Sprint(r.ID)] = name
		}
	}
	return names, nil
}
