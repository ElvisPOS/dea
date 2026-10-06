import { AgentInfo, Disk, Fleet, ServerInfo, Stats, StoreInfo } from './models';

// Pure helpers for the fleet tree and its resource figures (unit-tested in fleet.util.spec.ts).

export const WARN_AT = 80; // % of CPU, memory or the fullest disk
export const CRIT_AT = 90;
/** A report older than this is late (agents report every 60 s, stores relay at least every 30 s). */
export const LATE_MS = 150_000;

export type SortMode = 'az' | 'store';
export type Level = '' | 'warn' | 'crit';

/** One line of the fleet tree: this server, a store server or a POS. */
export interface FleetNode {
  id: string; // "server", "s:<store id>", "p:<agent key>"
  kind: 'central' | 'store' | 'pos';
  root?: boolean; // the server this UI runs on
  parent?: FleetNode;
  children: FleetNode[];
  online: boolean;
  stats?: Stats | null;
  seen?: string; // last seen, for offline devices
  name: string;
  host?: string;
  version?: string;
  storeId?: string;
  addr?: string; // store: address it connects from
  upstream?: string; // root store: the central it is linked to
  store?: StoreInfo;
  agent?: AgentInfo;
  key?: string; // POS: address on this server, "pos" or "store/pos"
  ip?: string;
  deviceId?: string;
}

/** An agent's address on this server: "pos" (direct) or "store/pos". */
export const keyOf = (a: AgentInfo) => (a.store ? `${a.store}/${a.id}` : a.id);

/** Store path of an agent key: "12" for "12/pos-1", "" for a POS connected directly. */
export function storeOf(key: string) {
  const i = key.lastIndexOf('/');
  return i < 0 ? '' : key.slice(0, i);
}

/** A POS is shown by its system.devices description, or its id (hostname). */
export const agentName = (a?: AgentInfo) => (a && (a.name || a.id)) || '';

export const pct = (used: number, total: number) => (total ? (100 * used) / total : 0);
export const diskPct = (d: Disk) => pct(d.used, d.used + d.avail);
export const levelOf = (p: number): Level => (p >= CRIT_AT ? 'crit' : p >= WARN_AT ? 'warn' : '');

export function worstDisk(st?: Stats | null): Disk | null {
  let w: Disk | null = null;
  for (const d of st?.disks || []) if (!w || diskPct(d) > diskPct(w)) w = d;
  return w;
}

/** Severity of the worst of CPU, memory and the fullest disk: 0, 1 (80–89%) or 2 (90%+). */
export function sev(n: FleetNode): 0 | 1 | 2 {
  if (!n.online || !n.stats) return 0;
  const d = worstDisk(n.stats);
  const m = Math.max(n.stats.cpu || 0, pct(n.stats.mem_used, n.stats.mem_total), d ? diskPct(d) : 0);
  return m >= CRIT_AT ? 2 : m >= WARN_AT ? 1 : 0;
}

export const isLate = (n: FleetNode, now = Date.now()) => !!(n.online && n.stats && now - Date.parse(n.stats.at) > LATE_MS);
export const needsAttention = (n: FleetNode) => sev(n) > 0 || isLate(n);
export const posOf = (n: FleetNode) => n.children.filter((c) => c.kind === 'pos');

export function humanBytes(n: number): string {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function walk(n: FleetNode, fn: (n: FleetNode) => void) {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

export function findNode(root: FleetNode | null, id: string): FleetNode | null {
  let hit: FleetNode | null = null;
  if (root) walk(root, (n) => (n.id === id ? (hit = n) : null));
  return hit;
}

export interface TreeOptions {
  sort: SortMode;
  lang: string;
  centralName: string; // "Central server"
  thisStoreName: string; // "This store server"
  upstream?: string;
}

function compareIds(a: string, b: string, coll: Intl.Collator) {
  const x = Number(a), y = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return coll.compare(a, b);
}

/** POS in a store: by name (A–Z) or by device id, POS without one last. */
export function compareAgents(a: AgentInfo, b: AgentInfo, sort: SortMode, coll: Intl.Collator) {
  if (sort === 'store') {
    const x = a.device_id ? Number(a.device_id) : Infinity;
    const y = b.device_id ? Number(b.device_id) : Infinity;
    if (x !== y) return x - y;
  }
  return coll.compare(agentName(a), agentName(b)) || coll.compare(a.id, b.id);
}

/** Builds the tree: this server, its stores (sorted), their POS, then POS connected directly. */
export function buildTree(f: Fleet, o: TreeOptions): FleetNode {
  const coll = new Intl.Collator(o.lang, { numeric: true, sensitivity: 'base' });
  const me: ServerInfo = f.server ?? { role: 'central', store_id: '', hostname: '', version: '' };
  const selfStore = me.role === 'store';
  const root: FleetNode = {
    id: 'server', kind: selfStore ? 'store' : 'central', root: true, online: true, stats: me.stats,
    name: selfStore ? me.store_name || o.thisStoreName : o.centralName,
    host: me.hostname, version: me.version, storeId: selfStore ? me.store_id : '', upstream: o.upstream, children: [],
  };
  const stores = [...f.stores].sort((x, y) =>
    o.sort === 'store' ? compareIds(x.id, y.id, coll) : coll.compare(x.name || x.id, y.name || y.id) || compareIds(x.id, y.id, coll),
  );
  const byStore = new Map<string, FleetNode>();
  for (const s of stores) {
    const n: FleetNode = {
      id: `s:${s.id}`, kind: 'store', parent: root, store: s, online: s.online, stats: s.stats, seen: s.last_seen,
      name: s.name || s.id, host: s.hostname, version: s.version, storeId: s.id,
      addr: (s.remote_addr || '').replace(/:\d+$/, ''), children: [],
    };
    byStore.set(s.id, n);
    root.children.push(n);
  }
  const direct: FleetNode[] = [];
  for (const a of [...f.agents].sort((x, y) => compareAgents(x, y, o.sort, coll))) {
    const parent = byStore.get((a.store || '').split('/')[0]) || root;
    const n: FleetNode = {
      id: `p:${keyOf(a)}`, kind: 'pos', parent, agent: a, key: keyOf(a), online: a.online, stats: a.stats, seen: a.last_seen,
      name: agentName(a), host: a.hostname || a.id, ip: (a.ips && a.ips[0]) || (a.remote_addr || '').replace(/:\d+$/, ''),
      deviceId: a.device_id, version: a.version, children: [],
    };
    (parent === root ? direct : parent.children).push(n);
  }
  root.children.push(...direct);
  return root;
}

/** Search text and filter of the fleet page. */
export function matches(n: FleetNode, query: string, filter: string): boolean {
  const q = query.toLowerCase();
  if (q) {
    const hay = [n.name, n.host, n.ip, n.addr, n.storeId, n.deviceId, n.key].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (filter === 'online') return n.online;
  if (filter === 'offline') return !n.online;
  if (filter === 'warn') return needsAttention(n) || !n.online;
  return true;
}
