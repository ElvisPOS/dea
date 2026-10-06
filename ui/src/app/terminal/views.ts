import { Injectable, effect, inject, signal } from '@angular/core';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import RFB from '@novnc/novnc';
import { Backend, TermSocket } from '../core/backend';
import { FleetStore } from '../core/fleet-store';
import { I18n } from '../core/i18n';
import { Theme } from '../core/theme';

export type ViewState = 'wait' | 'live' | 'dead';
export type ViewKind = 'term' | 'screen';
export type View = TermSession | ScreenSession;

const encoder = new TextEncoder();

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

  private term: Terminal;
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
}

/** Creates terminal and screen views, and repaints terminals when the theme changes. */
@Injectable({ providedIn: 'root' })
export class Views {
  private i18n = inject(I18n);
  private fleet = inject(FleetStore);
  private deps: ViewDeps = {
    backend: inject(Backend),
    theme: inject(Theme),
    t: (k, v) => this.i18n.t(k, v),
    err: (m) => this.i18n.err(m),
    keyLabel: (k) => this.fleet.keyLabel(k),
    live: new Set(),
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
