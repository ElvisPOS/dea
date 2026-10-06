import { Injectable, effect, inject, signal } from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import RFB from '@novnc/novnc';
import { ConfirmationService } from '@openng/optimus-ui/api';
import { Backend, TermSocket } from '../core/backend';
import { FleetStore } from '../core/fleet-store';
import { I18n } from '../core/i18n';
import { Theme } from '../core/theme';

export type ViewState = 'wait' | 'live' | 'dead';
export type ViewKind = 'term' | 'screen';
export type View = TermSession | ScreenSession;

const encoder = new TextEncoder();

/** Largest file a POS accepts (the agent checks it too). */
export const MAX_UPLOAD = 1 << 30;
const CHUNK = 64 << 10;
const MAX_BUFFERED = 2 << 20; // bytes queued on the socket before waiting

/** What a terminal shows while files dropped on it are uploaded to its current folder. */
export interface UploadState {
  name: string;
  size: number;
  saved: number; // bytes the POS has written
  phase: 'wait' | 'send' | 'done' | 'error';
  path?: string;
  error?: string;
  index: number; // 1-based, of count
  count: number;
}

interface UploadMsg {
  type: string;
  name?: string;
  path?: string;
  size?: number;
  error?: string;
  exists?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One shell on one POS, drawn into its own element so it can move between panes
 * and tabs without reconnecting. Press Enter in a dropped shell to reconnect.
 */
export class TermSession {
  readonly kind = 'term' as const;
  readonly state = signal<ViewState>('wait');
  readonly el = document.createElement('div');
  /** A tab may fan keystrokes out to all its panes ("Type in all"). */
  onInput?: (src: TermSession, data: Uint8Array) => void;
  /** The other view of the same POS kept connected in the background. */
  twin?: View;
  /** The file being uploaded, or the result of the last one. */
  readonly upload = signal<UploadState | null>(null);

  private term: Terminal;
  private uploading = false;
  private cancelUpload = false;
  private uploadMsgs: UploadMsg[] = [];
  private wakeUpload?: () => void;
  private clearTimer?: ReturnType<typeof setTimeout>;
  private fitAddon = new FitAddon();
  private ws?: TermSocket;
  private dead = false;
  private closed = false;
  private resizeObs: ResizeObserver;

  constructor(
    readonly agentKey: string,
    readonly label: string,
    private deps: ViewDeps,
  ) {
    this.el.className = 'term-host';
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: 14,
      lineHeight: 1.15, // at 1.0 some monospace fonts clip underscores
      scrollback: 10000,
      theme: deps.theme.terminal(),
    });
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.el);
    this.term.onData((d) => {
      if (this.dead) {
        if (d === '\r') this.connect();
        return;
      }
      this.input(encoder.encode(d));
    });
    this.term.onBinary((d) => this.input(Uint8Array.from(d, (c) => c.charCodeAt(0))));
    this.term.onResize(({ cols, rows }) => this.send(JSON.stringify({ type: 'resize', cols, rows })));
    this.resizeObs = new ResizeObserver(() => this.fit());
    this.resizeObs.observe(this.el);
    deps.live.add(this);
  }

  setTheme() {
    this.term.options.theme = this.deps.theme.terminal();
  }

  focus() {
    this.term.focus();
  }

  /** Only a visible terminal can be measured. */
  fit() {
    if (this.el.offsetParent === null) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* not laid out yet */
    }
  }

  send(data: string | Uint8Array) {
    // while a file goes out, binary frames are file data: keystrokes wait
    if (this.uploading && typeof data !== 'string') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data as never);
  }

  input(data: Uint8Array) {
    this.onInput ? this.onInput(this, data) : this.send(data);
  }

  connect() {
    const { t, err } = this.deps;
    this.dead = false;
    let live = false;
    this.state.set('wait');
    this.fit();
    const ws = this.deps.backend.openTerminal(this.agentKey, this.term.cols, this.term.rows);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.term.write(`\x1b[2m[${t('term.connecting', { name: this.deps.keyLabel(this.agentKey) })}]\x1b[0m\r\n`);
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        if (!live) {
          live = true;
          this.state.set('live');
        }
        this.term.write(new Uint8Array(ev.data));
        return;
      }
      let m: { type?: string; error?: string; code?: number };
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type?.startsWith('upload_')) {
        this.onUploadMsg(m as UploadMsg);
        return;
      }
      if (m.type === 'error') this.term.write(`\r\n\x1b[31m[${t('term.error', { msg: err(m.error || '') })}]\x1b[0m\r\n`);
      if (m.type === 'exit') this.term.write(`\r\n\x1b[2m[${t('term.exited', { code: m.code })}]\x1b[0m\r\n`);
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return;
      this.dead = true;
      this.state.set('dead');
      this.term.write(`\r\n\x1b[33m[${t('term.disconnected')}]\x1b[0m\r\n`);
    };
  }

  /**
   * Uploads files, one after the other, into the folder the terminal is in. The
   * POS asks before replacing a file; folders are refused (zip them first).
   */
  async uploadFiles(files: File[], folders: string[] = []): Promise<void> {
    const { t } = this.deps;
    if (this.uploading) return;
    clearTimeout(this.clearTimer);
    if (folders.length) {
      this.uploadFailed(folders[0], t('upload.folder', { name: folders[0] }));
      return;
    }
    if (this.state() !== 'live') {
      this.uploadFailed(files[0]?.name ?? '', t('upload.notLive'));
      return;
    }
    this.uploading = true;
    this.cancelUpload = false;
    try {
      for (let i = 0; i < files.length && !this.cancelUpload; i++) {
        const ok = await this.uploadOne(files[i], i + 1, files.length);
        if (!ok) return;
      }
      if (!this.cancelUpload) this.clearTimer = setTimeout(() => this.upload.set(null), 8000);
    } finally {
      this.uploading = false;
      this.focus();
    }
  }

  /** Stops the upload in progress; the POS deletes the partial file. */
  stopUpload() {
    this.cancelUpload = true;
  }

  dismissUpload() {
    if (!this.uploading) this.upload.set(null);
  }

  private async uploadOne(file: File, index: number, count: number): Promise<boolean> {
    const { t, err } = this.deps;
    const st: UploadState = { name: file.name, size: file.size, saved: 0, phase: 'wait', index, count };
    this.upload.set(st);
    if (file.size > MAX_UPLOAD) return this.uploadFailed(file.name, t('upload.tooBig', { name: file.name }));
    this.uploadMsgs = [];

    // ask the POS where the file goes (and whether it may replace it)
    let overwrite = false;
    let reply: UploadMsg | null;
    for (;;) {
      this.ws!.send(JSON.stringify({ type: 'upload', name: file.name, size: file.size, overwrite }));
      reply = await this.nextUploadMsg(10_000);
      if (!reply) return this.uploadFailed(file.name, t(this.ws?.readyState === WebSocket.OPEN ? 'upload.tooOld' : 'upload.notLive'));
      if (reply.type === 'upload_error' && reply.exists && !overwrite) {
        overwrite = await this.deps.confirm(t('upload.exists', { path: reply.path }));
        if (!overwrite) {
          this.upload.set({ ...st, phase: 'error', error: t('upload.kept', { name: file.name }) });
          return true; // skip this one, go on with the others
        }
        continue;
      }
      break;
    }
    if (reply.type !== 'upload_ready') return this.uploadFailed(file.name, err(reply.error || ''));
    this.upload.set({ ...st, phase: 'send', path: reply.path });

    // send the bytes, never queueing more than MAX_BUFFERED on the socket
    for (let off = 0; off < file.size; off += CHUNK) {
      const early = this.uploadMsgs.find((m) => m.type === 'upload_error');
      if (this.cancelUpload || early || this.ws?.readyState !== WebSocket.OPEN) {
        this.ws?.send(JSON.stringify({ type: 'upload_cancel' }));
        if (early) return this.uploadFailed(file.name, err(early.error || ''));
        this.upload.set({ ...this.upload()!, phase: 'error', error: t('upload.cancelled', { name: file.name }) });
        return false;
      }
      while (this.ws.bufferedAmount > MAX_BUFFERED) await sleep(15);
      this.ws.send(new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer()));
    }

    // the POS confirms once the file is in place
    for (;;) {
      const m = await this.nextUploadMsg(120_000);
      if (!m) return this.uploadFailed(file.name, t('upload.noAnswer'));
      if (m.type === 'upload_done') {
        this.upload.set({ ...this.upload()!, phase: 'done', saved: file.size, path: m.path });
        return true;
      }
      if (m.type === 'upload_error') return this.uploadFailed(file.name, err(m.error || ''));
    }
  }

  private uploadFailed(name: string, msg: string): false {
    const cur = this.upload();
    this.upload.set({ ...(cur ?? { size: 0, saved: 0, index: 1, count: 1 }), name, phase: 'error', error: msg });
    return false;
  }

  private onUploadMsg(m: UploadMsg) {
    if (m.type === 'upload_progress') {
      const cur = this.upload();
      if (cur && cur.name === m.name) this.upload.set({ ...cur, saved: m.size ?? cur.saved });
      return;
    }
    this.uploadMsgs.push(m);
    this.wakeUpload?.();
  }

  private async nextUploadMsg(timeout: number): Promise<UploadMsg | null> {
    const until = Date.now() + timeout;
    while (!this.uploadMsgs.length) {
      if (Date.now() > until || this.ws?.readyState !== WebSocket.OPEN) return null;
      await new Promise<void>((r) => {
        this.wakeUpload = r;
        setTimeout(r, 250);
      });
    }
    return this.uploadMsgs.shift()!;
  }

  close() {
    this.deps.live.delete(this);
    this.closed = true;
    this.ws?.close();
    this.resizeObs.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}

/** What the screen overlay shows: a message, and a Reconnect button or the password form. */
export interface ScreenMessage {
  text: string;
  action?: 'retry' | 'password';
}

/**
 * A POS screen through its VNC server (x11vnc on the POS), view-only until "Take
 * control". The VNC password is asked in the page and kept in memory only.
 */
export class ScreenSession {
  readonly kind = 'screen' as const;
  readonly state = signal<ViewState>('wait');
  readonly viewOnly = signal(true);
  readonly message = signal<ScreenMessage | null>(null);
  readonly el = document.createElement('div');
  onInput?: undefined;
  twin?: View;

  private rfb: RFB | null = null;
  private password: string | null = null;
  private authFailed = false;
  private closed = false;

  constructor(
    readonly agentKey: string,
    readonly label: string,
    private deps: ViewDeps,
  ) {
    this.el.className = 'screen-canvas';
  }

  async connect() {
    const { t, err } = this.deps;
    this.disconnectRfb();
    this.state.set('wait');
    this.message.set({ text: t('screen.checking') });
    try {
      await this.deps.backend.vncCheck(this.agentKey);
    } catch (e) {
      if (this.closed) return;
      this.state.set('dead');
      this.message.set({ text: err((e as Error).message), action: 'retry' });
      return;
    }
    if (this.closed) return;
    const url = this.deps.backend.vncUrl(this.agentKey);
    if (!url) {
      this.state.set('dead');
      this.message.set({ text: t('screen.noViewer'), action: 'retry' });
      return;
    }
    this.message.set({ text: t('screen.connecting') });
    const rfb = new RFB(this.el, url);
    rfb.viewOnly = this.viewOnly();
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = getComputedStyle(document.documentElement).getPropertyValue('--bg-page').trim();
    rfb.addEventListener('connect', () => {
      this.state.set('live');
      this.message.set(null);
    });
    rfb.addEventListener('credentialsrequired', () => {
      if (this.password) rfb.sendCredentials({ password: this.password });
      else this.message.set({ text: t('screen.passwordPrompt'), action: 'password' });
    });
    rfb.addEventListener('securityfailure', () => {
      this.password = null;
      this.authFailed = true;
    });
    rfb.addEventListener('disconnect', (e: CustomEvent<{ clean: boolean }>) => {
      if (this.closed || this.rfb !== rfb) return;
      this.rfb = null;
      this.state.set('dead');
      const text = this.authFailed ? t('screen.wrongPassword') : e.detail.clean ? t('screen.closed') : t('screen.lost');
      this.authFailed = false;
      this.message.set({ text, action: 'retry' });
    });
    this.rfb = rfb;
  }

  sendPassword(password: string) {
    if (!password || !this.rfb) return;
    this.password = password;
    this.message.set({ text: this.deps.t('screen.connecting') });
    this.rfb.sendCredentials({ password });
  }

  setViewOnly(v: boolean) {
    this.viewOnly.set(v);
    if (this.rfb) this.rfb.viewOnly = v;
    if (!v) this.focus();
  }

  ctrlAltDel() {
    this.rfb?.sendCtrlAltDel();
    this.focus();
  }

  setTheme() {}

  fit() {} // the VNC client scales to its pane by itself

  focus() {
    if (!this.viewOnly()) this.rfb?.focus();
  }

  private disconnectRfb() {
    const r = this.rfb;
    this.rfb = null;
    try {
      r?.disconnect();
    } catch {
      /* already closed */
    }
  }

  close() {
    this.closed = true;
    this.disconnectRfb();
    this.el.remove();
  }
}

/** What views need from the app, bundled so they can stay plain classes. */
export interface ViewDeps {
  backend: Backend;
  theme: Theme;
  t: (key: string, vars?: Record<string, unknown>) => string;
  err: (msg: string) => string;
  keyLabel: (key: string) => string;
  live: Set<View>;
  /** Asks a yes/no question (replace a file?) in a dialog. */
  confirm: (message: string) => Promise<boolean>;
}

/** Creates terminal and screen views, and repaints terminals when the theme changes. */
@Injectable({ providedIn: 'root' })
export class Views {
  private i18n = inject(I18n);
  private fleet = inject(FleetStore);
  private confirmation = inject(ConfirmationService);
  private deps: ViewDeps = {
    backend: inject(Backend),
    theme: inject(Theme),
    t: (k, v) => this.i18n.t(k, v),
    err: (m) => this.i18n.err(m),
    keyLabel: (k) => this.fleet.keyLabel(k),
    live: new Set(),
    confirm: (message) =>
      new Promise<boolean>((resolve) =>
        this.confirmation.confirm({
          header: this.i18n.t('upload.existsTitle'),
          message,
          icon: 'pi pi-exclamation-triangle',
          acceptLabel: this.i18n.t('upload.replace'),
          rejectLabel: this.i18n.t('upload.keep'),
          rejectButtonProps: { severity: 'secondary', outlined: true },
          accept: () => resolve(true),
          reject: () => resolve(false),
        }),
      ),
  };

  constructor() {
    effect(() => {
      this.deps.theme.name();
      for (const v of this.deps.live) v.setTheme();
    });
  }

  create(kind: ViewKind, agentKey: string, label: string): View {
    return kind === 'screen' ? new ScreenSession(agentKey, label, this.deps) : new TermSession(agentKey, label, this.deps);
  }
}
