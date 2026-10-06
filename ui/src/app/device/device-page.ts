import {
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from '@openng/optimus-ui/button';
import { InputTextModule } from '@openng/optimus-ui/inputtext';
import { SelectModule } from '@openng/optimus-ui/select';
import { FleetNode, diskPct, findNode, humanBytes, levelOf, pct, posOf } from '../core/fleet.util';
import { FleetStore } from '../core/fleet-store';
import { I18n, TPipe } from '../core/i18n';
import { Session } from '../core/session';
import { Tabs } from '../core/tabs';
import { FleetRow } from '../fleet/fleet-row';
import { ListHead } from '../fleet/list-head';
import { Dot, Meter, Role } from '../shared/ui';

/**
 * One device (OVERVIEW tab): breadcrumbs, resource cards, disks and details; a POS
 * adds terminal, screen and logs buttons and a command box; a store lists its POS.
 */
@Component({
  selector: 'dea-device-page',
  imports: [FormsModule, ButtonModule, InputTextModule, SelectModule, Dot, Meter, Role, FleetRow, ListHead, TPipe],
  templateUrl: './device-page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { class: 'pane-body device' },
})
export class DevicePage {
  protected fleet = inject(FleetStore);
  protected tabs = inject(Tabs);
  protected i18n = inject(I18n);
  private session = inject(Session);

  readonly nodeId = input.required<string>();

  protected node = computed(() => findNode(this.fleet.tree(), this.nodeId()));
  /** Fleet › this server › store › POS */
  protected chain = computed(() => {
    const out: FleetNode[] = [];
    for (let c: FleetNode | undefined = this.node() ?? undefined; c; c = c.parent) out.unshift(c);
    return out;
  });
  protected kids = computed(() => (this.node() ? posOf(this.node()!) : []));
  protected st = computed(() => this.node()?.stats ?? null);
  protected memP = computed(() => (this.st() ? pct(this.st()!.mem_used, this.st()!.mem_total) : 0));
  protected level = levelOf;
  protected diskPct = diskPct;
  protected humanBytes = humanBytes;

  protected memText = computed(() => {
    const st = this.st()!;
    return (
      `${humanBytes(st.mem_used)} / ${humanBytes(st.mem_total)}` +
      (st.swap_total ? ` · ${this.i18n.t('res.swap')} ${humanBytes(st.swap_used)}` : '')
    );
  });

  /** Details table rows: [label key, value]; empty values are left out. */
  protected details = computed<[string, string][]>(() => {
    const n = this.node();
    if (!n) return [];
    let rows: [string, string | undefined][];
    if (n.kind === 'pos') {
      const a = n.agent!;
      rows = [
        ['det.host', a.hostname],
        ['det.addr', (a.ips || []).join(', ') || n.ip],
        ['det.posId', a.device_id],
        ['det.store', this.fleet.storeName(a.store) || a.store],
        ['det.os', a.os],
        ['det.user', a.user],
        ['det.agent', a.version],
        ['det.from', a.remote_addr],
      ];
    } else if (n.kind === 'store' && !n.root) {
      const s = n.store!;
      rows = [
        ['det.storeId', s.id],
        ['det.host', s.hostname],
        ['det.addr', n.addr],
        ['det.version', s.version],
        [
          'det.conn',
          s.online
            ? this.i18n.t('store.up', { ago: this.i18n.ago(s.connected_at) })
            : this.i18n.t('store.offline', { ago: this.i18n.ago(s.last_seen) }),
        ],
      ];
    } else {
      rows = [
        ['det.host', n.host],
        ['det.version', n.version],
        ['det.storeId', n.storeId],
        ['det.upstream', n.upstream],
      ];
    }
    return rows.filter((r): r is [string, string] => !!r[1]);
  });

  // command box (POS)
  private cmdInput = viewChild<ElementRef<HTMLInputElement>>('cmdInput');
  protected cmd = signal('');
  protected timeout = signal(30);
  protected readonly timeouts = [
    { value: 10, label: '10 s' },
    { value: 30, label: '30 s' },
    { value: 120, label: '2 min' },
    { value: 600, label: '10 min' },
  ];
  protected running = signal(false);
  protected last = computed(() => {
    const n = this.node();
    return n?.key ? (this.fleet.lastExec().get(n.key) ?? null) : null;
  });

  protected focusCmd() {
    this.cmdInput()?.nativeElement.focus();
  }

  protected async run() {
    const n = this.node();
    const cmd = this.cmd().trim();
    if (!n?.key || !cmd || this.running()) return this.focusCmd();
    this.running.set(true);
    try {
      await this.fleet.exec([n.key], cmd, this.timeout());
    } catch (e) {
      this.session.handle(e);
      const m = new Map(this.fleet.lastExec());
      m.set(n.key, {
        cmd,
        result: { id: n.key, ok: false, code: 0, output: '', error: (e as Error).message, ms: 0 },
      });
      this.fleet.lastExec.set(m);
    } finally {
      this.running.set(false);
    }
  }

  protected lastText() {
    const r = this.last()!.result;
    return (
      (r.output || '') +
      (r.error
        ? (r.output ? '\n' : '') + this.i18n.t('exec.error', { msg: this.i18n.err(r.error) })
        : '')
    );
  }
}
