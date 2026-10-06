import { AgentInfo, Fleet, Stats, StoreInfo } from '../app/core/models';

// Sample fleets for `npm run mock` and the Playwright checks. Pick one with
// ?scenario=<name>; every state the UI can show appears in at least one.

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Resource figures: cpu %, memory %, disks as [mount, % used, size in GB], uptime in hours, report age in seconds. */
function stats(cpu: number, mem: number, disks: [string, number, number][], upHours: number, ageSec = 12, memGB = 3.8): Stats {
  return {
    at: new Date(Date.now() - ageSec * 1000).toISOString(),
    cpus: 4,
    cpu,
    load: [cpu / 25, cpu / 30, cpu / 40],
    mem_total: memGB * GB,
    mem_used: (mem / 100) * memGB * GB,
    swap_total: 2 * GB,
    swap_used: mem > 80 ? 0.4 * GB : 0,
    disks: disks.map(([path, p, size]) => {
      const total = size * GB;
      const used = (p / 100) * total;
      return { path, total, used, avail: total - used };
    }),
    uptime: upHours * 3600,
  };
}

const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

function pos(
  store: string,
  id: string,
  device: string | undefined,
  name: string | undefined,
  ip: string,
  st: Stats | undefined,
  opts: { offline?: boolean; version?: string } = {},
): AgentInfo {
  return {
    id, store, hostname: id, device_id: device, name, os: 'Debian GNU/Linux 12 (bookworm)', arch: 'amd64', user: 'elvispos',
    version: opts.version ?? 'v2.0.0', ips: [ip], remote_addr: `${ip}:41822`, first_seen: ago(86400 * 30),
    last_seen: ago(opts.offline ? 3 * 3600 : 5), connected_at: opts.offline ? undefined : ago(5 * 3600),
    online: !opts.offline, sessions: 0, stats: opts.version && opts.version < 'v1.6' ? undefined : st,
  };
}

function store(id: string, name: string, addr: string, st: Stats | undefined, offline = false): StoreInfo {
  return {
    id, name, hostname: 'amacrai-store-server', version: 'v2.0.0', remote_addr: `${addr}:51022`,
    first_seen: ago(86400 * 60), last_seen: ago(offline ? 2 * 86400 : 4), connected_at: offline ? undefined : ago(8 * 60),
    online: !offline, stats: offline ? stats(3, 40, [['/', 22, 61]], 900, 2 * 86400) : st,
  };
}

const central = () => ({ role: 'central' as const, store_id: '', hostname: 'amacrai-central-server', version: 'v2.0.0', stats: stats(4, 61, [['/', 12, 67]], 1863, 8, 1.9) });

export const SCENARIOS: Record<string, () => Fleet> = {
  /** Central, four stores (one offline) and POS in every state: warnings, late, old agent, offline. */
  fleet: () => ({
    server: central(),
    stores: [
      store('12', '001707 AMACO Fiume Veneto', '7.7.7.201', stats(4, 58, [['/', 18, 61]], 1457)),
      store('14', '001712 AMACO Pordenone Centro', '7.7.7.214', stats(22, 91, [['/', 44, 61]], 292)),
      store('21', '001730 AMACO Udine Via Roma', '7.7.7.230', stats(6, 40, [['/', 30, 61]], 700)),
      store('33', '001745 AMACO Treviso Outlet', '7.7.7.245', undefined, true),
    ],
    agents: [
      pos('12', 'memphis-pos-101', '101', '#1 CASSA 1', '10.12.0.11', stats(6, 42, [['/', 31, 72.7], ['/boot', 95, 0.46]], 92)),
      pos('12', 'memphis-pos-102', '102', '#2 CASSA 2', '10.12.0.12', stats(12, 38, [['/', 94, 30]], 92)),
      pos('12', 'memphis-pos-169', '75', '#3 4POS VM', '192.168.56.105', stats(1, 39, [['/', 10, 72.7], ['/boot', 12, 0.46], ['/boot/efi', 0, 0.5]], 154)),
      pos('12', 'memphis-pos-103', '103', '#3 CASSA 3 SELF', '10.12.0.13', undefined, { version: 'v1.5.0' }),
      pos('12', 'memphis-pos-104', '104', '#4 CASSA 4', '10.12.0.14', stats(35, 71, [['/', 88, 30]], 92), { offline: true }),
      pos('14', 'memphis-pos-201', '201', '#1 CASSA 1', '10.14.0.11', stats(6, 42, [['/', 21, 72.7]], 73)),
      pos('14', 'memphis-pos-202', '202', '#2 CASSA 2 BANCO GASTRONOMIA', '10.14.0.12', stats(22, 91, [['/', 64, 30]], 73)),
      pos('14', 'memphis-pos-lab', undefined, undefined, '10.14.0.99', stats(5, 44, [['/', 23, 72.7]], 73, 200)),
      pos('21', 'memphis-pos-301', '301', '#1 CASSA 1', '10.21.0.11', stats(6, 40, [['/', 30, 30]], 40), { offline: true }),
      pos('21', 'memphis-pos-302', '302', '#2 CASSA 2', '10.21.0.12', stats(8, 45, [['/', 31, 30]], 92)),
      pos('21', 'memphis-pos-305', '303', '#5 SELF CHECKOUT', '10.21.0.15', stats(96, 83, [['/', 47, 30]], 92)),
      pos('33', 'memphis-pos-401', '401', '#1 CASSA 1', '10.33.0.11', stats(6, 42, [['/', 31, 30]], 100), { offline: true }),
    ],
  }),

  /** Only central and POS connected to it directly. */
  'central-only': () => ({
    server: central(),
    stores: [],
    agents: [
      pos('', 'cassa-1', '1', '#1 CASSA 1', '192.168.1.21', stats(9, 47, [['/', 35, 60]], 30)),
      pos('', 'cassa-2', '2', '#2 CASSA 2', '192.168.1.22', stats(14, 82, [['/', 52, 60]], 30)),
      pos('', 'cassa-3', '3', '#3 SELF', '192.168.1.23', stats(3, 30, [['/', 91, 60]], 30), { offline: true }),
    ],
  }),

  /** A store server's own UI: its POS under the store. */
  store: () => ({
    server: { role: 'store', store_id: '12', store_name: '001707 AMACO Fiume Veneto', hostname: 'amacrai-store-server', version: 'v2.0.0', stats: stats(4, 58, [['/', 18, 61]], 1457) },
    stores: [],
    agents: [
      pos('', 'memphis-pos-101', '101', '#1 CASSA 1', '10.12.0.11', stats(6, 42, [['/', 31, 72.7]], 92)),
      pos('', 'memphis-pos-169', '75', '#3 4POS VM', '192.168.56.105', stats(1, 39, [['/', 10, 72.7]], 154)),
    ],
  }),

  /** A new install: nothing connected yet. */
  empty: () => ({ server: central(), stores: [], agents: [] }),

  /** 30 stores × 8 POS, to check the list at scale. */
  big: () => {
    const stores: StoreInfo[] = [];
    const agents: AgentInfo[] = [];
    for (let s = 1; s <= 30; s++) {
      const id = String(100 + s);
      stores.push(store(id, `0017${String(s).padStart(2, '0')} AMACO Store ${s}`, `7.7.7.${s}`, stats(5 + (s % 7), 40 + (s % 30), [['/', 20 + s, 61]], 500)));
      for (let p = 1; p <= 8; p++) {
        const n = s * 10 + p;
        agents.push(pos(id, `pos-${n}`, String(n), `#${p} CASSA ${p}`, `10.${s}.0.${p}`, stats((n * 7) % 100, (n * 13) % 100, [['/', (n * 17) % 100, 30]], 50), { offline: n % 11 === 0 }));
      }
    }
    return { server: central(), stores, agents };
  },
};

export const LOG_FILES = (key: string) => [
  { dir: 'client_agent/log', files: ['elvis-CLIENT0.log', 'elvis-CLIENT0.log.1', 'elvis-CLIENT0.log.2'] },
  { dir: 'gui/logs', files: ['gui.log', 'gui-errors.log'] },
  { dir: 'dea/log', files: ['dea-agent.log'] },
].flatMap(({ dir, files }) =>
  files.map((f, i) => ({
    path: `/usr/share/elvispos/${dir}/${f}`,
    name: `${dir}/${f}`,
    size: Math.round((key.length * 37 + i * 911 + f.length * 4099) * (i ? 3 : 41)) % (40 * MB),
    mtime: ago(600 + i * 86400),
  })),
);
