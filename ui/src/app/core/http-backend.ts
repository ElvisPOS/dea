import { Injectable } from '@angular/core';
import { Backend, TermSocket, Unauthorized } from './backend';
import { ExecResult, Fleet, LogFile, Me } from './models';

/** The real dea-server API (same origin; in development `ng serve` proxies /api). */
@Injectable()
export class HttpBackend extends Backend {
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: init.body ? { 'Content-Type': 'application/json' } : {},
      ...init,
    });
    if (res.status === 401 && path !== '/api/login') throw new Unauthorized();
    if (res.status === 204) return null as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data as T;
  }

  login(user: string, password: string) {
    return this.call<void>('/api/login', { method: 'POST', body: JSON.stringify({ user, password }) });
  }

  logout() {
    return this.call<void>('/api/logout', { method: 'POST' });
  }

  me() {
    return this.call<Me>('/api/me');
  }

  fleet() {
    return this.call<Fleet>('/api/agents');
  }

  forgetAgent(key: string) {
    return this.call<void>(`/api/agents/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
  }

  forgetStore(id: string) {
    return this.call<void>(`/api/stores/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  exec(agents: string[], cmd: string, timeout: number) {
    return this.call<ExecResult[]>('/api/exec', { method: 'POST', body: JSON.stringify({ agents, cmd, timeout }) });
  }

  logs(key: string) {
    return this.call<LogFile[]>(`/api/logs?agent=${encodeURIComponent(key)}`);
  }

  // Fetched (not a plain link) so errors show in the page instead of as a downloaded file.
  async downloadLogs(key: string, paths: string[] | null, progress: (bytes: number) => void) {
    const q = new URLSearchParams({ agent: key });
    if (paths) paths.forEach((p) => q.append('f', p));
    else q.set('all', '1');
    const res = await fetch(`/api/logs/download?${q}`, { credentials: 'same-origin' });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const reader = res.body!.getReader();
    const chunks: BlobPart[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      progress(got);
    }
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'logs.tar.gz';
    return { name, blob: new Blob(chunks, { type: 'application/gzip' }) };
  }

  vncCheck(key: string) {
    return this.call<void>(`/api/vnc/check?agent=${encodeURIComponent(key)}`);
  }

  openTerminal(key: string, cols: number, rows: number): TermSocket {
    const q = new URLSearchParams({ agent: key, cols: String(cols), rows: String(rows) });
    return new WebSocket(`${wsBase()}/api/term?${q}`);
  }

  vncUrl(key: string) {
    return `${wsBase()}/api/vnc?agent=${encodeURIComponent(key)}`;
  }
}

function wsBase() {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
}
