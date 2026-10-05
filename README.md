# DEA · Diagnostic Elvis Agent: terminals, screens, logs and resources for a POS fleet

Each tier can only open connections **upward**, so every link is dialed from below:

```
browser ──▶ central  (dea-server, :7681)
               ▲   one WebSocket per store, opened by the store
            store server  (dea-server, linked to its REPLICATION_SERVER_ADDRESS)
               ▲   one WebSocket per POS, opened by the POS
              POS  (dea-agent, @reboot cron)
```

- **POS** run `dea-agent`, a static Go binary in `/usr/share/elvispos/dea/` (with `start`/`stop`
  scripts and a pid file, like the other ElvisPOS components). It runs as a detached process, started
  at boot by root's crontab; not in `screen`, because the POS `stopall` runs `killall -9 screen`. It dials
  its store server, reconnects with backoff, and spawns a login shell on a PTY for each terminal.
- **Store servers** run `dea-server`. They hold their POS connections, keep one link up to
  central, push the POS list to central and relay terminals and commands. They also have
  their own web UI for in-store use.
- **Central** runs `dea-server` with `DEA_STORE_TOKEN`. Its UI lists every store and POS
  (grouped by store). It opens terminals and runs a command on many POS at once.

A terminal is a chain of WebSockets: browser → central → store → POS. Each hop asks the hop
below to *dial back* a socket for that session id, then splices the two.

## Install: `ecli dea`

ElvisPOS servers and POS install dea with `ecli` (repo `ecli`, `src/util/dea.ts`).

1. Build: `make dist VERSION=v1.9.0` writes two static linux/amd64 binaries to `dist/`. Put them on
   central: `dea-server` in `~/com-elvispos-engine/bin/`, `dea-agent` in
   `~/com-elvispos-engine/share/RELEASE/elvispos/dea/`. `make deploy VERSION=v1.9.0 CENTRAL=elvispos@<central>
   SSH_PORT=22` copies both and runs `ecli dea install` on central.
2. Central (silver): `ecli dea install` runs `bin/dea-server` as the `dea` stack (like `bin/Sam.jar`: the
   `openjdk8:stable` base image with the binary mounted read-only) and writes the POS agent's
   `share/ALL/elvispos/dea/{start,stop}`.
3. Each store server: `ecli dea install` fetches `bin/dea-server` and the POS release from central, then runs the
   stack. The store links to the central in `REPLICATION_SERVER_ADDRESS` (port 7681) as store
   `STORE_REPLICATION_ID`, both from ElvisPOS store replication; central's store token is read over the ecli SSH
   link. Later updates arrive with the regular server sync (`bin/dea-server` is synced with the jars).
4. Each POS: `ecli dea install`. Like every POS component, the agent comes from the store by rsync
   (`share/RELEASE/elvispos/dea/dea-agent`, `share/ALL/elvispos/dea/{start,stop}`); the token from the store's
   `share/STORE_SEEDS/dea-agent.env`. ecli writes only `dea.env` and root's crontab line. The agent connects
   to `memphisserver`.

Servers run the stack from `~/com-elvispos-engine/docker-compose.dea-agent.yml` (the same file on every
server). The `DEA_*` secrets are in `~/com-elvispos-engine/config/elvisenv`; store and POS names come from
`ybservice` on `network-backend`. `ecli dea status`, `ecli dea uninstall [--purge]` and
`ecli start|stop|restart|logs dea` also work. After a new `bin/dea-server`, `ecli dea install` (or
`ecli restart dea`) starts it.

## Add a POS

On the POS, as `elvispos`:

```sh
ecli dea install            # optional: --id NAME (defaults to the hostname)
```

ecli writes `dea.env` and adds
`@reboot su elvispos -c /usr/share/elvispos/dea/start >> /usr/share/elvispos/dea/start.log 2>&1` to
root's crontab; no system service. Shells run as `elvispos`. Remove with `ecli dea uninstall`, check with
`ecli dea status`. Logs: `/usr/share/elvispos/dea/log/dea-agent.log`.

## Security notes

- Central only accepts clients in `DEA_ALLOW_CIDRS`: the VPN, plus the host itself. From
  outside the VPN use a tunnel: `ssh -p 4168 -L 7681:localhost:7681 elvispos@amacrai.elvispos.com`
  and open http://localhost:7681.
- Three separate secrets: the browser admin login, the per-server POS token
  (`DEA_AGENT_TOKEN`) and central's store token (`DEA_STORE_TOKEN`). A POS token cannot
  register a store. Exec results are only accepted on the link the request went out on.
- Traffic is plain `ws://`/`http://` and relies on the VPN for encryption.
- Every server logs logins, terminal sessions (open/close, who, how long) and fleet commands:
  `ecli logs dea` (or `docker service logs dea_agent`).
