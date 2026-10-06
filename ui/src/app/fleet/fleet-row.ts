import { Component, computed, inject, input } from '@angular/core';
import { FleetNode, diskPct, humanBytes, isLate, needsAttention, pct, posOf, sev, worstDisk } from '../core/fleet.util';
import { FleetStore } from '../core/fleet-store';
import { I18n, TPipe } from '../core/i18n';
import { Tabs } from '../core/tabs';
import { Dot, Icon, Meter, Role } from '../shared/ui';
import { RowMenu } from './row-menu';

/**
 * One device of the fleet tree, on the list's grid: select · device · CPU · memory ·
 * disk · load · uptime · reported · shortcuts · ⋯. Clicking the row opens its overview.
 */
@Component({
  selector: '[deaFleetRow]',
  imports: [Dot, Icon, Meter, Role, TPipe],
  host: {
    class: 'rt-grid rt-row',
    role: 'row',
    tabindex: '0',
    '[attr.data-id]': 'node().id',
    '[class.is-pos]': "node().kind === 'pos'",
    '[class.is-store]': "node().kind === 'store'",
    '[class.is-central]': "node().kind === 'central'",
    '[class.is-root]': 'node().root',
    '[class.is-off]': '!node().online',
    '[class.is-selected]': 'checked()',
    '(click)': 'onClick($event)',
  },
  template: `
    <!-- select -->
    @if (node().kind === 'pos') {
      <input type="checkbox" class="rt-check" [checked]="checked()" (change)="fleet.toggleSelected([node().key!], $any($event.target).checked)" [attr.aria-label]="'row.select' | t: { name: node().name }" />
    } @else if (kids().length) {
      <input type="checkbox" class="rt-check" [checked]="allKids()" [indeterminate]="someKids()" (change)="selectStore($any($event.target).checked)" [attr.aria-label]="'row.selectStore' | t: { name: node().name }" />
    } @else {
      <span></span>
    }

    <!-- device -->
    <div class="rt-cell-dev">
      <span class="rt-tree">
        @for (g of guides(); track $index) {
          <i [class]="g"></i>
        }
      </span>
      @if (node().kind === 'store' && !node().root) {
        <button type="button" class="rt-caret" [attr.aria-expanded]="!collapsed()" [attr.aria-label]="'row.expand' | t" (click)="fleet.setCollapsed(node().storeId!, !collapsed())">
          <dea-icon name="caret" />
        </button>
      }
      <dea-dot [node]="node()" />
      <span class="rt-dev-text">
        <span class="rt-dev-line">
          <span class="rt-name" [title]="node().name">{{ node().name }}</span>
          @if (node().kind !== 'pos') {
            <dea-role [kind]="node().kind" />
          }
          @if (node().kind === 'store' && kids().length) {
            <span class="rt-count" [class.is-partial]="kidsOn() > 0 && kidsOn() < kids().length" [class.is-down]="kidsOn() === 0" [title]="'row.countTitle' | t">{{ kidsOn() }}/{{ kids().length }}</span>
            @if (collapsed() && flagged().length) {
              <span class="rt-flag" [class.is-crit]="flaggedCrit()" [title]="'row.flagTitle' | t">! {{ flagged().length }}</span>
            }
          }
        </span>
        <span class="rt-meta">{{ meta() }}</span>
      </span>
    </div>

    <!-- resources -->
    @if (node().online && node().stats; as st) {
      <dea-meter [p]="st.cpu" [tip]="'res.cores' | t: { n: st.cpus }" />
      <dea-meter [p]="memPct()" [tip]="memText()" />
      <dea-meter [p]="diskP()" [tip]="disksText()" />
      <span class="rt-num" [title]="'res.loadTitle' | t">{{ (st.load[0] || 0).toFixed(2) }}</span>
      <span class="rt-num">{{ i18n.duration(st.uptime) }}</span>
      <span class="rt-age" [class.is-stale]="late()">{{ 'logs.ago' | t: { ago: i18n.ago(st.at) } }}</span>
    } @else {
      <span class="rt-offtxt">{{ noStatsText() }}</span>
      <span></span>
      <span></span>
      <span class="rt-age">{{ node().online ? '–' : i18n.ago(node().seen) }}</span>
    }

    <!-- shortcuts -->
    <span class="rt-acts">
      <button type="button" class="rt-act" [title]="'menu.details' | t" (click)="tabs.openDevice(node().id)"><dea-icon name="overview" /></button>
      @if (node().kind === 'pos') {
        <button type="button" class="rt-act" [title]="'act.terminal' | t" [disabled]="!node().online" (click)="tabs.openTerminal(node().key!, node().name)"><dea-icon name="terminal" /></button>
        <button type="button" class="rt-act" [title]="'menu.logs' | t" [disabled]="!node().online" (click)="tabs.openLogs(node().key!, node().name)"><dea-icon name="logs" /></button>
      }
    </span>
    <button type="button" class="rt-more" [attr.aria-label]="'row.actions' | t: { name: node().name }" (click)="menu.show(node(), $any($event.currentTarget))"><dea-icon name="more" /></button>
  `,
})
export class FleetRow {
  protected fleet = inject(FleetStore);
  protected tabs = inject(Tabs);
  protected menu = inject(RowMenu);
  protected i18n = inject(I18n);

  readonly node = input.required<FleetNode>();
  /** Tree guide classes, one per level: is-tee, is-elbow, is-pipe or "". */
  readonly guides = input<string[]>([]);

  protected kids = computed(() => posOf(this.node()));
  protected kidsOn = computed(() => this.kids().filter((p) => p.online).length);
  protected checked = computed(() => this.node().kind === 'pos' && this.fleet.selected().has(this.node().key!));
  protected selCount = computed(() => this.kids().filter((p) => this.fleet.selected().has(p.key!)).length);
  protected allKids = computed(() => this.selCount() > 0 && this.selCount() === this.kids().length);
  protected someKids = computed(() => this.selCount() > 0 && this.selCount() < this.kids().length);
  protected collapsed = computed(() => !!this.node().storeId && this.fleet.collapsed().has(this.node().storeId!));
  protected flagged = computed(() => this.kids().filter(needsAttention));
  protected flaggedCrit = computed(() => this.flagged().some((p) => sev(p) === 2));
  protected late = computed(() => isLate(this.node()));

  protected memPct = computed(() => {
    const st = this.node().stats!;
    return pct(st.mem_used, st.mem_total);
  });
  protected diskP = computed(() => {
    const d = worstDisk(this.node().stats);
    return d ? diskPct(d) : null;
  });
  protected memText = computed(() => {
    const st = this.node().stats!;
    return `${humanBytes(st.mem_used)} / ${humanBytes(st.mem_total)}` + (st.swap_total ? ` · ${this.i18n.t('res.swap')} ${humanBytes(st.swap_used)}` : '');
  });
  protected disksText = computed(() =>
    (this.node().stats?.disks || []).map((d) => `${d.path}  ${Math.round(diskPct(d))}% ${this.i18n.t('res.of', { size: humanBytes(d.total) })}`).join('\n'),
  );

  protected meta = computed(() => {
    const n = this.node();
    if (n.kind === 'central') return [n.host, n.version].filter(Boolean).join(' · ');
    if (n.kind === 'store') return [n.storeId && `#${n.storeId}`, n.root ? n.host : n.addr, n.version].filter(Boolean).join(' · ');
    return [n.host, n.ip, n.deviceId && `ID ${n.deviceId}`].filter(Boolean).join(' · ');
  });

  protected noStatsText = computed(() => {
    const n = this.node();
    if (!n.online) return this.i18n.t('row.offline', { ago: this.i18n.ago(n.seen) });
    if (n.root) return this.i18n.t('res.waiting');
    return this.i18n.t('row.old', { version: n.version || '?' });
  });

  protected selectStore(on: boolean) {
    this.fleet.toggleSelected(this.kids().map((p) => p.key!), on);
    if (on && this.node().storeId) this.fleet.setCollapsed(this.node().storeId!, false);
  }

  protected onClick(ev: MouseEvent) {
    if ((ev.target as HTMLElement).closest('input, button')) return;
    this.tabs.openDevice(this.node().id);
  }
}
