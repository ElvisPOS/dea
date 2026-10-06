import { Injectable } from '@angular/core';
import { Backend, TermSocket, Unauthorized } from '../app/core/backend';
import { keyOf } from '../app/core/fleet.util';
import { ExecResult, Fleet, LogFile, Me } from '../app/core/models';
import { LOG_FILES, SCENARIOS } from './scenarios';

const params = new URLSearchParams(location.search);
export const SCENARIO = SCENARIOS[params.get('scenario') || ''] ? params.get('scenario')! : 'fleet';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The server API on sample data (npm run mock). Logged in from the start unless
 * ?login=1; any password works except "wrong". Removing a device and running
 * commands work on the in-memory fleet; screens report that VNC is not running.
 */
@Injectable()
export class MockBackend extends Backend {
  private fleetData: Fleet = SCENARIOS[SCENARIO]();
  private loggedIn = params.get('login') !== '1';

  private guard() {
    if (!this.loggedIn) throw new Unauthorized();
  }

  async login(user: string, password: string) {
    await sleep(150);
    if (!user || password === 'wrong') throw new Error('wrong user or password');
    this.loggedIn = true;
  }

  async logout() {
    this.loggedIn = false;
  }

  async me(): Promise<Me> {
    this.guard();
    const store = this.fleetData.server?.role === 'store';
    return {
      user: 'admin',
      upstream: store ? 'ws://7.7.7.179:7681' : '',
      store_id: store ? this.fleetData.server!.store_id : '',
      store_setup: store ? undefined : 'DEA_UPSTREAM_TOKEN=3f1c0d7e9a2b4c6d8e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b',
    };
  }

  async fleet(): Promise<Fleet> {
    this.guard();
    return structuredClone(this.fleetData);
  }

  async forgetAgent(key: string) {
    this.guard();
    this.fleetData.agents = this.fleetData.agents.filter((a) => keyOf(a) !== key);
  }

  async forgetStore(id: string) {
    this.guard();
    this.fleetData.stores = this.fleetData.stores.filter((s) => s.id !== id);
    this.fleetData.agents = this.fleetData.agents.filter((a) => a.store.split('/')[0] !== id);
  }

  async exec(keys: string[], cmd: string): Promise<ExecResult[]> {
    this.guard();
    await sleep(400);
    return keys.map((id) => {
      const a = this.fleetData.agents.find((x) => keyOf(x) === id);
      if (!a?.online) return { id, ok: false, code: 0, output: '', error: 'agent is offline', ms: 0 };
      return { id, ok: true, code: 0, output: fakeOutput(cmd, a.hostname), ms: 40 + (id.length * 13) % 200 };
    });
  }

  async logs(key: string): Promise<LogFile[]> {
    this.guard();
    await sleep(200);
    return LOG_FILES(key);
  }

  async downloadLogs(key: string, paths: string[] | null, progress: (bytes: number) => void) {
    this.guard();
    const files = LOG_FILES(key).filter((f) => !paths || paths.includes(f.path));
    for (let i = 1; i <= 5; i++) {
      await sleep(120);
      progress(i * 300_000);
    }
    const text = files.map((f) => `${f.path}\n`).join('');
    return { name: `${key.replace(/\//g, '-')}-logs.tar.gz`, blob: new Blob([text], { type: 'application/gzip' }) };
  }

  async vncCheck() {
    this.guard();
    await sleep(300);
    throw new Error('VNC is not running on this POS');
  }

  openTerminal(key: string): TermSocket {
    const a = this.fleetData.agents.find((x) => keyOf(x) === key);
    return new FakeShell(a?.hostname || key, !!a?.online);
  }

  vncUrl() {
    return null;
  }
}

function fakeOutput(cmd: string, host: string, files: string[] = []): string {
  const c = cmd.trim();
  if (c === 'hostname') return `${host}\n`;
  if (c.startsWith('uptime')) return ' 09:41:07 up 6 days,  2:13,  0 users,  load average: 0.21, 0.18, 0.15\n';
  if (c.startsWith('df')) return 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        73G  7.0G   62G  11% /\n';
  if (c.startsWith('whoami')) return 'elvispos\n';
  if (c.startsWith('ls')) return ['client_agent', 'dea', 'elvisenv', 'gui', 'lib', 'startall', 'startvnc', 'stopall', ...files].sort().join('  ') + '\n';
  return `(mock) ran: ${c}\n`;
}

/** A pretend shell for terminals in mock mode: echoes typing and answers a few commands. */
class FakeShell implements TermSocket {
  binaryType: BinaryType = 'arraybuffer';
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  private line = '';
  /** Files "uploaded" to the home folder, shown by ls. A file named exists.txt is
   * already there; noperm.txt cannot be written. */
  private files: string[] = ['exists.txt'];
  private upload: { name: string; size: number; got: number; acked: number; replacing: boolean } | null = null;
  private enc = new TextEncoder();
  private prompt: string;

  constructor(private host: string, online: boolean) {
    this.prompt = `\x1b[1;32melvispos@${host}\x1b[0m:\x1b[1;34m~\x1b[0m$ `;
    setTimeout(() => {
      if (!online) {
        this.emitText(JSON.stringify({ type: 'error', error: 'agent is offline' }));
        return this.close();
      }
      this.readyState = WebSocket.OPEN;
      this.write(`Linux ${host} 6.1.0-18-amd64 #1 SMP Debian x86_64  (DEA mock shell)\r\n\r\n${this.prompt}`);
    }, 250);
  }

  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
    if (typeof data === 'string') {
      this.control(JSON.parse(data));
      return;
    }
    if (this.upload) {
      this.receive((data as Uint8Array).byteLength);
      return;
    }
    const text = new TextDecoder().decode(data as Uint8Array);
    for (const ch of text) {
      if (ch === '\r') {
        const out = this.line.trim() === 'exit' ? '' : this.line.trim() ? fakeOutput(this.line, this.host, this.files).replace(/\n/g, '\r\n') : '';
        if (this.line.trim() === 'exit') {
          this.write('\r\nlogout\r\n');
          this.emitText(JSON.stringify({ type: 'exit', code: 0 }));
          return this.close();
        }
        this.write(`\r\n${out}${this.prompt}`);
        this.line = '';
      } else if (ch === '\x7f') {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          this.write('\b \b');
        }
      } else if (ch >= ' ') {
        this.line += ch;
        this.write(ch);
      }
    }
  }

  /** Upload messages, as the real agent answers them (resize is ignored). */
  private control(m: { type: string; name?: string; size?: number; overwrite?: boolean }) {
    const reply = (r: object) => setTimeout(() => this.emitText(JSON.stringify(r)), 60);
    const path = `/home/elvispos/${m.name}`;
    if (m.type === 'upload_cancel') this.upload = null;
    if (m.type !== 'upload') return;
    if (m.name === 'noperm.txt') {
      reply({ type: 'upload_error', name: m.name, error: 'no permission to write in /home/elvispos' });
    } else if (this.files.includes(m.name!) && !m.overwrite) {
      reply({ type: 'upload_error', name: m.name, path, exists: true });
    } else {
      this.upload = { name: m.name!, size: m.size!, got: 0, acked: 0, replacing: this.files.includes(m.name!) };
      reply({ type: 'upload_ready', name: m.name, path });
      if (!m.size) this.receive(0);
    }
  }

  private receive(n: number) {
    const u = this.upload!;
    u.got += n;
    if (u.got < u.size) {
      if (u.got - u.acked >= 256 << 10) {
        u.acked = u.got;
        this.emitText(JSON.stringify({ type: 'upload_progress', name: u.name, size: u.got }));
      }
      return;
    }
    this.upload = null;
    if (!this.files.includes(u.name)) this.files.push(u.name);
    const backup = u.replacing ? `/home/elvispos/.dea-replaced/${new Date().toISOString().slice(0, 10)}/${u.name}` : undefined;
    setTimeout(() => this.emitText(JSON.stringify({ type: 'upload_done', name: u.name, path: `/home/elvispos/${u.name}`, size: u.size, replaced: !!backup, backup })), 60);
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    setTimeout(() => this.onclose?.(new CloseEvent('close')), 0);
  }

  private write(s: string) {
    this.onmessage?.(new MessageEvent('message', { data: this.enc.encode(s).buffer }));
  }

  private emitText(s: string) {
    this.onmessage?.(new MessageEvent('message', { data: s }));
  }
}
