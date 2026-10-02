FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
ENV CGO_ENABLED=0
# the POS agent ships in the image for "ecli rterm publish", which copies it into
# central's share/RELEASE/elvispos/rterm/ for the normal POS release flow
RUN go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/rterm-server ./cmd/rterm-server \
 && GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" \
      -o /out/dist/rterm-agent-linux-amd64 ./cmd/rterm-agent

FROM alpine:3.20
RUN adduser -D -u 10001 rterm && mkdir /data && chown rterm /data
COPY --from=build /out/rterm-server /usr/local/bin/rterm-server
COPY --from=build /out/dist /app/dist
USER rterm
ENV RTERM_LISTEN=:7681 RTERM_DATA=/data
EXPOSE 7681
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7681/healthz || exit 1
ENTRYPOINT ["rterm-server"]
