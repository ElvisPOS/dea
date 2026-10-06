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

## Upload a file to a POS

Drop files on a terminal pane (or use **Upload** in its header): they are saved in the folder the
terminal is in at that moment, i.e. where `cd` took you, as `elvispos`. DEA asks before replacing a
file (a replaced file keeps its permissions), refuses folders (zip them) and files over 1 GB, and
checks free space first. The file is written next to its target under a temporary name and renamed
when complete, so a cancelled or broken upload leaves nothing behind.

The file travels inside the terminal's own WebSocket, through central and the store unchanged; only
the POS agent and the browser take part, so it needs dea-agent v2.3.0 or later on the POS (older
agents get an "update the agent" message and receive nothing). Writing into a root-only folder
fails with "no permission": upload to `/tmp` and `sudo mv`.

Every upload is audited, from the request to its outcome, on both ends:

- the server the user signed in to (and each store it passes through) logs every event in
  `logs/dea/dea-server.log` and writes one JSON line per event to `logs/dea/uploads.log` (10 MB,
  20 old files kept): user, browser address, POS, file name, size, overwrite asked, final path,
  bytes sent, SHA-256 of the saved file, replaced file and its old size, duration, error;
- the POS agent logs the same in `/usr/share/elvispos/dea/log/dea-agent.log` and
  `/usr/share/elvispos/dea/log/uploads.log`, with the DEA user who opened the terminal
  (`by: admin@10.8.0.5`, sent by central when the terminal opens).

Events: `requested`, `exists` (the user is asked to replace), `refused` (with the reason),
`started`, `saved`, `failed`, `cancelled` and `interrupted` (the terminal closed mid-upload).
The agent never puts a file in place without its `saved` line and SHA-256. The server's record
ends in `saved` too, or in `interrupted` when the browser left before the POS confirmed (the POS
record then tells whether the file was saved).

## Security notes

- Central only accepts clients in `DEA_ALLOW_CIDRS`: the VPN, plus the host itself. From
  outside the VPN use a tunnel: `ssh -p 4168 -L 7681:localhost:7681 elvispos@amacrai.elvispos.com`
  and open http://localhost:7681.
- Three separate secrets: the browser admin login, the per-server POS token
  (`DEA_AGENT_TOKEN`) and central's store token (`DEA_STORE_TOKEN`). A POS token cannot
  register a store. Exec results are only accepted on the link the request went out on.
- Traffic is plain `ws://`/`http://` and relies on the VPN for encryption.
- Every server logs logins, terminal sessions (open/close, who, how long) and fleet commands:
  `~/com-elvispos-engine/logs/dea/dea-server.log` (rotated at 10 MB, 5 old files kept; set by
  `DEA_LOG_DIR` in the compose file), also in `docker service logs dea_agent`. `ecli dea status`
  shows the path.

## Working on the UI

The web UI is an Angular app in `ui/` (standalone components and signals, one folder per screen:
`fleet/`, `device/`, `terminal/`, `logs/`, `login/`; data access in `core/`, styles in
`src/styles/`). `make dist` builds it into `web/dist`, which is embedded into `dea-server`.
Needs Node 22+ (`cd ui && nvm use && npm ci` once).

Buttons, inputs, selects, the filter segments, the dialog, the row menu, tooltips and the logs
table are [Optimus UI](https://github.com/openng-org/optimus-ui) components (the MIT community
continuation of PrimeNG 21; docs at https://optimus.openng.org, icons `pi pi-*` from
`@openng/icons`). Their colours come from the design-system tokens in `src/styles/_tokens.scss`
through the preset in `src/app/core/optimus-theme.ts`: change a colour there and both the custom
parts (fleet tree, meters, KPI tiles, terminal panes) and the components follow, in both themes.

| Command (in `ui/`) | What it does |
|---|---|
| `npm run mock` | UI on http://localhost:4300 with a fake fleet, no server needed. The picker at the bottom right switches scenario (`fleet`, `central-only`, `store`, `empty`, `big`); the mock POS shell answers a few commands. `?login=1` starts on the login page. |
| `npm start` | UI on http://localhost:4200 against a real server; `/api` and the WebSockets go to `DEA_URL` (default `http://127.0.0.1:7681`). For central: `ssh -L 7681:localhost:7681 elvispos@7.7.7.179`, then `npm start`. |
| `npm run check` | Opens every screen in the mock (both themes, Italian, menus, dialogs, splits) and compares it with the reference screenshots in `e2e/__screenshots__`; also checks behaviour (search, keyboard, store rule, login). Uses the installed Google Chrome. |
| `npm run check:report` | Shows the last check, with the expected/actual/diff images of every changed screen. |
| `npm run check:update` | Accepts the current look as the new reference, after a deliberate change. Commit the PNGs with the change. |
| `npm test` | Unit tests of the fleet logic (tree, sorting, health levels, search), in `*.spec.ts`. |
| `npm run build` | Production build into `web/dist` (what `make ui` runs). |

Edit and save: both servers reload the page. A typical fix: reproduce it in `npm run mock` (add a
case to `src/mock/scenarios.ts` if the data is unusual), fix it, run `npm run check`, look at the
report, then `npm run check:update`.
