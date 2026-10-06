// Data exchanged with dea-server (/api/*). Field names follow the JSON.

export interface Disk {
  path: string;
  total: number;
  used: number;
  avail: number;
}

/** A host's resource usage; sizes in bytes, cpu in %, uptime in seconds. */
export interface Stats {
  at: string;
  cpus: number;
  cpu: number;
  load: number[];
  mem_total: number;
  mem_used: number;
  swap_total: number;
  swap_used: number;
  disks: Disk[];
  uptime: number;
}

export interface AgentInfo {
  id: string;
  store: string; // store path ("" = connected to this server directly)
  hostname: string;
  device_id?: string;
  name?: string; // system.devices description
  os: string;
  arch: string;
  user: string;
  version: string;
  ips: string[] | null;
  remote_addr: string;
  first_seen: string;
  last_seen: string;
  connected_at?: string;
  online: boolean;
  sessions: number;
  stats?: Stats;
}

export interface StoreInfo {
  id: string;
  name?: string; // system.store description
  hostname: string;
  version: string;
  remote_addr: string;
  first_seen: string;
  last_seen: string;
  connected_at?: string;
  online: boolean;
  stats?: Stats;
}

/** The server the browser is talking to. */
export interface ServerInfo {
  role: 'central' | 'store';
  store_id: string;
  store_name?: string;
  hostname: string;
  version: string;
  stats?: Stats | null;
}

export interface Fleet {
  agents: AgentInfo[];
  stores: StoreInfo[];
  server: ServerInfo | null;
}

export interface Me {
  user: string;
  upstream: string; // central's address, on a store server
  store_id: string;
  store_setup?: string; // the line a store needs, on central
}

export interface ExecResult {
  id: string;
  ok: boolean;
  code: number;
  output: string;
  error?: string;
  ms: number;
}

export interface LogFile {
  path: string;
  name: string;
  size: number;
  mtime: string;
}
