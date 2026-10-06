import {
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from '@openng/optimus-ui/button';
import { DialogModule } from '@openng/optimus-ui/dialog';
import { IconFieldModule } from '@openng/optimus-ui/iconfield';
import { InputIconModule } from '@openng/optimus-ui/inputicon';
import { InputTextModule } from '@openng/optimus-ui/inputtext';
import { SelectModule } from '@openng/optimus-ui/select';
import { SelectButtonModule } from '@openng/optimus-ui/selectbutton';
import { FleetNode, findNode, keyOf, matches, posOf } from '../core/fleet.util';
import { FleetStore } from '../core/fleet-store';
import { I18n, TPipe } from '../core/i18n';
import { ExecResult } from '../core/models';
import { Session } from '../core/session';
import { Tabs } from '../core/tabs';
import { ExecResults } from './exec-results';
import { FleetRow } from './fleet-row';
import { ListHead } from './list-head';

interface Row {
  node: FleetNode;
  guides: string[];
}

/**
 * The home page: the whole fleet as one tree (this server, each store server, its
 * POS) with live resources on every row, summary tiles, filters, and the command
 * bar for the ticked POS.
 */
@Component({
  selector: 'dea-fleet-page',
  imports: [
    FormsModule,
    ButtonModule,
    DialogModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    SelectModule,
    SelectButtonModule,
    FleetRow,
    ListHead,
    ExecResults,
    TPipe,
  ],
  templateUrl: './fleet-page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { class: 'pane-body home' },
})
export class FleetPage {
  protected fleet = inject(FleetStore);
  protected session = inject(Session);
  protected tabs = inject(Tabs);
  protected i18n = inject(I18n);

  private list = viewChild<ElementRef<HTMLElement>>('list');
  protected addOpen = signal(false);
  protected copied = signal<'' | 'store' | 'pos'>('');

  protected filterOptions = computed(() =>
    (['all', 'online', 'offline', 'warn'] as const).map((value) => ({ value, label: this.i18n.t('filter.' + value) })),
  );
  protected sortOptions = computed(() =>
    (['az', 'store'] as const).map((value) => ({ value, label: this.i18n.t('sort.' + value) })),
  );
  protected readonly timeouts = [
    { value: 10, label: '10 s' },
    { value: 30, label: '30 s' },
    { value: 120, label: '2 min' },
    { value: 600, label: '10 min' },
  ];

  // command bar
  protected cmd = signal('');
  protected timeout = signal(30);
  protected running = signal(false);
  protected results = signal<{ cmd: string; results: ExecResult[] | null; error?: string } | null>(
    null,
  );

  protected readonly c = this.fleet.counts;
  protected filtering = computed(() => !!this.fleet.query() || this.fleet.filter() !== 'all');

  /** The visible rows; a matching POS always shows with its store and this server above it. */
  protected rows = computed<Row[]>(() => {
    const root = this.fleet.tree();
    const q = this.fleet.query(),
      f = this.fleet.filter(),
      filtering = this.filtering();
    const m = (n: FleetNode) => matches(n, q, f);
    const branches = root.children
      .map((n) => {
        const kids = posOf(n).filter(m);
        const show = !filtering || m(n) || kids.length > 0;
        return show ? { n, kids: filtering ? kids : posOf(n) } : null;
      })
      .filter((b): b is { n: FleetNode; kids: FleetNode[] } => !!b);
    const rows: Row[] = [];
    if (!filtering || m(root) || branches.length) rows.push({ node: root, guides: [] });
    branches.forEach(({ n, kids }, i) => {
      const last = i === branches.length - 1;
      rows.push({ node: n, guides: [last ? 'is-elbow' : 'is-tee'] });
      if (n.kind === 'pos') return;
      const collapsed =
        this.fleet.collapsed().has(n.storeId!) && !(filtering && kids.length && !m(n));
      if (!collapsed)
        kids.forEach((p, j) =>
          rows.push({
            node: p,
            guides: [last ? '' : 'is-pipe', j === kids.length - 1 ? 'is-elbow' : 'is-tee'],
          }),
        );
    });
    return rows;
  });

  protected selectedOffline = computed(() => {
    const agents = this.fleet.data().agents;
    return [...this.fleet.selected()].filter((k) => !agents.find((a) => keyOf(a) === k)?.online)
      .length;
  });

  protected clearSelection() {
    this.fleet.selected.set(new Set());
  }

  protected setFilter(f: 'all' | 'online' | 'offline' | 'warn') {
    this.fleet.filter.set(f);
  }

  protected expandAll(open: boolean) {
    this.fleet.collapsed.set(open ? new Set() : new Set(this.fleet.data().stores.map((s) => s.id)));
  }

  protected async run() {
    const cmd = this.cmd().trim();
    if (!cmd || this.running()) return;
    const keys = [...this.fleet.selected()].sort();
    this.running.set(true);
    this.results.set({ cmd, results: null });
    try {
      const res = await this.fleet.exec(keys, cmd, this.timeout());
      res.sort(
        (a, b) =>
          Number(a.ok && a.code === 0) - Number(b.ok && b.code === 0) || a.id.localeCompare(b.id),
      );
      this.results.set({ cmd, results: res });
    } catch (e) {
      this.session.handle(e);
      this.results.set({ cmd, results: null, error: this.i18n.err((e as Error).message) });
    } finally {
      this.running.set(false);
    }
  }

  protected async copy(text: string, which: 'store' | 'pos') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard blocked: the text stays selectable */
    }
    this.copied.set(which);
    setTimeout(() => this.copied.set(''), 1500);
  }

  /** ↑/↓ move between rows, Enter opens, →/← expand or collapse a store, Space ticks a POS. */
  protected onKey(ev: KeyboardEvent) {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.rt-row');
    if (!row || ev.target !== row) return;
    const n = findNode(this.fleet.tree(), row.dataset['id']!);
    if (!n) return;
    if (ev.key === 'Enter') this.tabs.openDevice(n.id);
    else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && n.kind === 'store' && !n.root)
      this.fleet.setCollapsed(n.storeId!, ev.key === 'ArrowLeft');
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const rows = [...this.list()!.nativeElement.querySelectorAll<HTMLElement>('.rt-row')];
      rows[rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (ev.key === ' ' && n.kind === 'pos')
      this.fleet.toggleSelected([n.key!], !this.fleet.selected().has(n.key!));
    else return;
    ev.preventDefault();
  }
}
