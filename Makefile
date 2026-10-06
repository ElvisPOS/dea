# Build the two dea binaries (static, linux/amd64) into dist/:
#
#   dea-server  goes to central's ~/com-elvispos-engine/bin/dea-server
#   dea-agent   goes to central's ~/com-elvispos-engine/share/RELEASE/elvispos/dea/dea-agent
#
# Stores get both from central (the server sync, or right away with `ecli dea install`),
# POS get the agent from their store.
#
# The web UI (Angular, in ui/) is built first and embedded into dea-server;
# see README "Working on the UI".
#
#   make dist VERSION=v1.9.0
#   make deploy VERSION=v1.9.0 CENTRAL=elvispos@7.7.7.179 SSH_PORT=22   # copy to central and run ecli dea install there

VERSION  ?= $(shell git describe --tags --always --dirty 2>/dev/null || date +%Y%m%d%H%M%S)
CENTRAL  ?=
SSH_PORT ?= 22
LDFLAGS  := -s -w -X main.version=$(VERSION)
ENGINE   := com-elvispos-engine

.PHONY: ui vet dist deploy

UI_SRC := $(shell find ui/src ui/public -type f) ui/package-lock.json ui/angular.json

ui: web/dist/index.html

web/dist/index.html: $(UI_SRC)
	cd ui && npm ci --no-audit --no-fund && npm run build

vet: ui
	go vet ./...

dist: vet
	mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/dea-server ./cmd/dea-server
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/dea-agent ./cmd/dea-agent
	@echo "built dist/dea-server and dist/dea-agent $(VERSION)"

deploy: dist
	@test -n "$(CENTRAL)" || (echo "usage: make deploy CENTRAL=elvispos@<central> [SSH_PORT=22]"; exit 1)
	rsync -avz --chmod=F755 -e "ssh -p $(SSH_PORT)" dist/dea-server $(CENTRAL):$(ENGINE)/bin/dea-server
	ssh -p $(SSH_PORT) $(CENTRAL) "mkdir -p $(ENGINE)/share/RELEASE/elvispos/dea"
	rsync -avz --chmod=F755 -e "ssh -p $(SSH_PORT)" dist/dea-agent $(CENTRAL):$(ENGINE)/share/RELEASE/elvispos/dea/dea-agent
	ssh -p $(SSH_PORT) $(CENTRAL) "cd $(ENGINE) && ecli dea install"
