package main

import (
	"os"
	"time"

	"dea/internal/proto"
	"dea/internal/sysstat"
)

// The server reports its own host's resource usage: in /api/agents for its own
// UI and, on a store, in every snapshot to central. It runs in a container, so
// disks are measured through files bind-mounted from the host filesystems
// (DEA_DISKS, written by ecli); without them only the data volume is measured.

func (s *server) runSelfStats() {
	probes := s.cfg.Disks
	if len(probes) == 0 {
		probes = []sysstat.Probe{{Label: "docker", Path: s.cfg.DataDir}}
	}
	for {
		st := s.sampler.Sample(probes)
		s.statsMu.Lock()
		s.lastSelf = st
		s.statsMu.Unlock()
		time.Sleep(proto.StatsInterval)
	}
}

func (s *server) selfStats() *proto.Stats {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	return s.lastSelf
}

// selfInfo describes this server for the UI's Resources tab.
func (s *server) selfInfo() map[string]any {
	role := "central"
	if s.cfg.Upstream != "" {
		role = "store"
	}
	hostname, _ := os.Hostname()
	return map[string]any{"role": role, "store_id": s.cfg.StoreID, "store_name": s.hub.StoreName(s.cfg.StoreID),
		"hostname": hostname, "version": version, "stats": s.selfStats()}
}
