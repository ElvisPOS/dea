import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Backend } from './backend';
import { FleetNode, SortMode, buildTree, isLate, keyOf, sev, storeOf, walk } from './fleet.util';
import { I18n } from './i18n';
import { ExecResult, Fleet } from './models';
import { loadPref, savePref } from './prefs';
import { Session } from './session';

const POLL_MS = 3000;

/** The fleet as last read from the server (polled while logged in) and the list's UI state. */
@Injectable({ providedIn: 'root' })
export class FleetStore {
  private backend = inject(Backend);
  private session = inject(Session);
  private i18n = inject(I18n);

  readonly data = signal<Fleet>({ agents: [], stores: [], server: null });
  readonly loaded = signal(false);

  // list state
  readonly query = signal('');
  readonly filter = signal<'all' | 'online' | 'offline' | 'warn'>('all');
  readonly sort = signal<SortMode>(loadPref('dea.sort', 'az'));
  readonly collapsed = signal<Set<string>>(new Set(loadPref<string[]>('dea.collapsed', [])));
  readonly selected = signal<Set<string>>(new Set()); // agent keys
  /** Last command run on each POS from this browser. */
  readonly lastExec = signal<Map<string, { cmd: string; result: ExecResult }>>(new Map());

  readonly tree = computed<FleetNode>(() =>
    buildTree(this.data(), {
      sort: this.sort(),
      lang: this.i18n.lang(),
      centralName: this.i18n.t('home.central'),
      thisStoreName: this.i18n.t('home.thisStore'),
      upstream: this.session.me()?.upstream,
    }),
  );

  /** Fleet totals for the summary tiles and the warning dot on the Fleet tab. */
  readonly counts = computed(() => {
    const all: FleetNode[] = [];
    walk(this.tree(), (n) => all.push(n));
    const stores = all.filter((n) => n.kind === 'store' && !n.root);
    const pos = all.filter((n) => n.kind === 'pos');
    return {
      stores: stores.length,
      storesUp: stores.filter((n) => n.online).length,
      pos: pos.length,
      posOnline: pos.filter((n) => n.online).length,
      offline: all.filter((n) => !n.online).length,
      warn: all.filter((n) => sev(n) === 1 || (isLate(n) && sev(n) === 0)).length,
      crit: all.filter((n) => sev(n) === 2).length,
    };
  });

  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => savePref('dea.sort', this.sort()));
    effect(() => savePref('dea.collapsed', [...this.collapsed()]));
    effect(() => {
      clearInterval(this.timer);
      if (this.session.state() !== 'app') return;
      this.refresh();
      this.timer = setInterval(() => this.refresh(), POLL_MS);
    });
  }

  async refresh() {
    try {
      const f = await this.backend.fleet();
      this.data.set(f);
      this.loaded.set(true);
      const known = new Set(f.agents.map(keyOf));
      const sel = this.selected();
      if ([...sel].some((k) => !known.has(k))) this.selected.set(new Set([...sel].filter((k) => known.has(k))));
    } catch (e) {
      this.session.handle(e);
    }
  }

  /** "001707 AMACO Fiume Veneto › #3 4POS VM" for an agent key. */
  keyLabel(key: string): string {
    const a = this.data().agents.find((x) => keyOf(x) === key);
    const i = key.lastIndexOf('/');
    const pos = a ? a.name || a.id : key.slice(i + 1);
    if (i < 0) return pos;
    const s = storeOf(key);
    return `${this.storeName(s) || s} › ${pos}`;
  }

  storeName(path: string): string {
    if (!path) return '';
    const st = this.data().stores.find((s) => s.id === path.split('/')[0]);
    const me = this.data().server;
    return st?.name || (me?.role === 'store' && path === me.store_id ? me.store_name || '' : '');
  }

  toggleSelected(keys: string[], on: boolean) {
    const s = new Set(this.selected());
    for (const k of keys) on ? s.add(k) : s.delete(k);
    this.selected.set(s);
  }

  setCollapsed(storeId: string, collapsed: boolean) {
    const s = new Set(this.collapsed());
    collapsed ? s.add(storeId) : s.delete(storeId);
    this.collapsed.set(s);
  }

  async exec(keys: string[], cmd: string, timeout: number): Promise<ExecResult[]> {
    const results = await this.backend.exec(keys, cmd, timeout);
    const m = new Map(this.lastExec());
    for (const r of results) m.set(r.id, { cmd, result: r });
    this.lastExec.set(m);
    return results;
  }

  async forget(n: FleetNode): Promise<void> {
    const what = n.kind === 'pos' ? n.key! : this.i18n.t('store.forgetWhat', { id: n.storeId });
    if (!confirm(this.i18n.t('confirm.forget', { what }))) return;
    try {
      if (n.kind === 'pos') await this.backend.forgetAgent(n.key!);
      else await this.backend.forgetStore(n.storeId!);
    } catch (e) {
      this.session.handle(e);
      alert(this.i18n.err((e as Error).message));
    }
    this.refresh();
  }
}
