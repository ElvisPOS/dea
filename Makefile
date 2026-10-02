# Build and publish the rterm-server image (server + agent binaries) to the ElvisPOS registry,
# as both :$(VERSION) and :latest. Servers pick up :latest with `ecli rterm install`.
#
#   make push VERSION=v1.0.3

REGISTRY ?= registry.elvispos.com
IMAGE    ?= com-elvispos-rterm-server
VERSION  ?= $(shell git describe --tags --always 2>/dev/null || date +%Y%m%d%H%M%S)

.PHONY: build push vet

vet:
	go vet ./...

build: vet
	docker build --platform linux/amd64 --build-arg VERSION=$(VERSION) -t $(REGISTRY)/$(IMAGE):$(VERSION) .

push: build
	docker tag $(REGISTRY)/$(IMAGE):$(VERSION) $(REGISTRY)/$(IMAGE):latest
	docker push $(REGISTRY)/$(IMAGE):$(VERSION)
	docker push $(REGISTRY)/$(IMAGE):latest
	@echo "pushed $(REGISTRY)/$(IMAGE):$(VERSION) and :latest (browse: http://$(REGISTRY):5001)"
