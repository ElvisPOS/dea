# ElvisPOS Remote Terminal (rterm): browser terminals for a POS fleet

Each tier can only open connections **upward**, so every link is dialed from below:

```
browser ──▶ central  (rterm-server, :7681)
               ▲   one WebSocket per store, opened by the store
            store server  (rterm-server with RTERM_UPSTREAM)
               ▲   one WebSocket per POS, opened by the POS
              POS  (rterm-agent, @reboot cron)
```

- **POS** run `rterm-agent`, a static Go binary in `/usr/share/elvispos/rterm/` (with `start`/`stop`
  scripts and a pid file, like the other ElvisPOS components). It runs as a detached process, started
  at boot by root's crontab; not in `screen`, because the POS `stopall` runs `killall -9 screen`. It dials
  its store server, reconnects with backoff, and spawns a login shell on a PTY for each terminal.
- **Store servers** run `rterm-server`. They hold their POS connections, keep one link up to
  central, push the POS list to central and relay terminals and commands. They also have
  their own web UI for in-store use.
- **Central** runs `rterm-server` with `RTERM_STORE_TOKEN`. Its UI lists every store and POS
  (grouped by store). It opens terminals and runs a command on many POS at once.

A terminal is a chain of WebSockets: browser → central → store → POS. Each hop asks the hop
below to *dial back* a socket for that session id, then splices the two.

## Production install: `ecli rterm`

ElvisPOS servers and POS install rterm with `ecli` (repo `ecli`, `src/util/rterm.ts`):

1. Publish the image: `make push VERSION=v1.0.3` pushes `:v1.0.3` and `:latest` to
   `registry.elvispos.com/com-elvispos-rterm-server` (browsable at http://registry.elvispos.com:5001).
   ecli deploys `:latest`, so a new image needs no ecli release: re-run `ecli rterm install` on each
   server (`--tag v1.0.3` pins a version).
2. Central (silver): `ecli rterm install`
3. Each store server: `ecli rterm install`. Central is `ecli.json` `sshParms.host` when it resolves into the store's
   VPN subnet; otherwise ecli asks for central's VPN IP (`--central <ip>` skips the question). The store id is
   `storeReplicationID` from `ecli.json`, and central's store token is read over the ecli SSH link.
4. Each POS: `ecli rterm install`. Like every POS component, the agent comes from the store by rsync:
   `share/RELEASE/elvispos/rterm/rterm-agent` and `share/ALL/elvispos/rterm/{start,stop}`. Central puts them
   there with `ecli rterm publish` (also run by `ecli rterm install` on central), and stores get them from
   central the same way. The token comes from the store's `share/STORE_SEEDS/rterm-agent.env`; ecli writes
   only `rterm.env` and root's crontab line. The agent connects to `memphisserver`.

Servers run the `rterm` stack from `~/com-elvispos-engine/docker-compose.rterm-agent.yml`, with the
`RTERM_*` settings in `~/com-elvispos-engine/config/elvisenv`. `ecli rterm status`, `ecli rterm uninstall
[--purge]`, and `ecli start|stop|logs rterm` also work.

## Manual deploy (outside ecli)

`deploy/deploy.sh` builds the image locally, pipes it over SSH (`docker save | docker load`)
and runs `docker stack deploy` (stack `rterm`, port 7681). On the first run it creates
`~/rterm/rterm.env` on the target with random secrets. `ENV_SET` adds or overrides settings
(see `deploy/rterm.env.example`):

```sh
# central
ENV_SET="RTERM_STORE_TOKEN=$(openssl rand -hex 24)
RTERM_ALLOW_CIDRS=7.7.7.0/24,127.0.0.0/8,172.18.0.1/32" \
  deploy/deploy.sh elvispos@amacrai.elvispos.com -p 4168

# each store (the token is central's RTERM_STORE_TOKEN; central's UI shows the snippet
# under Fleet → Add a store)
ENV_SET="RTERM_UPSTREAM=ws://7.7.7.172:7681
RTERM_UPSTREAM_TOKEN=<store token>
RTERM_STORE_ID=<unique store name>" \
  deploy/deploy.sh elvispos@<store> -p 4168
```

Later updates need no `ENV_SET`: just `deploy/deploy.sh user@host -p 4168`.

## Add a POS

On the POS, as `elvispos`:

```sh
ecli rterm install            # optional: --id NAME (defaults to the hostname)
```

The agent and its `start`/`stop` scripts come from the store by rsync, like every POS component
(`share/RELEASE/elvispos/rterm/` and `share/ALL/elvispos/rterm/`, published on central with
`ecli rterm publish`). ecli writes `rterm.env` and adds
`@reboot su elvispos -c /usr/share/elvispos/rterm/start >> /usr/share/elvispos/rterm/start.log 2>&1` to
root's crontab; no system service. Shells run as `elvispos`. Remove with `ecli rterm uninstall`, check with
`ecli rterm status`. Logs: `/usr/share/elvispos/rterm/log/rterm-agent.log`. Older installs (systemd service,
screen session) are migrated by a reinstall. The server has no install script or download endpoint.

## Security notes

- Central only accepts clients in `RTERM_ALLOW_CIDRS`: the VPN, plus the host itself. From
  outside the VPN use a tunnel: `ssh -p 4168 -L 7681:localhost:7681 elvispos@amacrai.elvispos.com`
  and open http://localhost:7681.
- Three separate secrets: the browser admin login, the per-server POS token
  (`RTERM_AGENT_TOKEN`) and central's store token (`RTERM_STORE_TOKEN`). A POS token cannot
  register a store. Exec results are only accepted on the link the request went out on.
- Traffic is plain `ws://`/`http://` and relies on the VPN for encryption. For TLS, put a
  reverse proxy in front and use `https://`/`wss://` URLs.
- Every server logs logins, terminal sessions (open/close, who, how long) and fleet commands:
  `docker service logs rterm_server`.
