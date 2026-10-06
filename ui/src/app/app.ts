import { Component, OnInit, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DevicePage } from './device/device-page';
import { FleetPage } from './fleet/fleet-page';
import { RowMenuView } from './fleet/row-menu';
import { findNode } from './core/fleet.util';
import { FleetStore } from './core/fleet-store';
import { I18n, LANGS, TPipe } from './core/i18n';
import { Session } from './core/session';
import { Tab, Tabs } from './core/tabs';
import { Theme } from './core/theme';
import { LoginPage } from './login/login-page';
import { LogsPage } from './logs/logs-page';
import { ButtonModule } from '@openng/optimus-ui/button';
import { ConfirmDialogModule } from '@openng/optimus-ui/confirmdialog';
import { SelectModule } from '@openng/optimus-ui/select';
import { TooltipModule } from '@openng/optimus-ui/tooltip';
import { TermTabView } from './terminal/term-tab-view';

/** The app shell: login page, or the header bar with its tabs and the tab in front. */
@Component({
  selector: 'dea-root',
  imports: [
    FormsModule,
    LoginPage,
    FleetPage,
    DevicePage,
    TermTabView,
    LogsPage,
    RowMenuView,
    ButtonModule,
    ConfirmDialogModule,
    SelectModule,
    TooltipModule,
    TPipe,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './app.html',
  host: { '(window:dragover)': 'refuseDrop($event)', '(window:drop)': 'refuseDrop($event)' },
})
export class App implements OnInit {
  protected session = inject(Session);
  protected tabs = inject(Tabs);
  protected fleet = inject(FleetStore);
  protected theme = inject(Theme);
  protected i18n = inject(I18n);
  protected langOptions = LANGS.map((value) => ({ value, label: value.toUpperCase() }));

  /** Amber or red dot on the Fleet tab when something needs attention. */
  protected fleetDot = computed(() =>
    this.fleet.counts().crit ? 'crit' : this.fleet.counts().warn ? 'warn' : '',
  );

  /** A file dropped outside a terminal must not make the browser open it (and leave the app). */
  protected refuseDrop(ev: DragEvent) {
    if (ev.defaultPrevented || !ev.dataTransfer?.types.includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'none';
  }

  ngOnInit() {
    this.session.start();
  }

  protected deviceNode(tab: Tab) {
    return tab.kind === 'device' ? findNode(this.fleet.tree(), tab.nodeId) : null;
  }

  /** Label, status dot and badge of a tab. */
  protected termInfo(tab: Tab) {
    if (tab.kind !== 'term') return null;
    const views = tab.term.views();
    const first = views[0];
    const cur = tab.term.slots()[tab.term.focused()] || first;
    const pos = [...new Set(views.map((v) => v.agentKey))];
    const kinds = new Set(views.map((v) => v.kind));
    return {
      state: cur?.state() ?? '',
      kind:
        kinds.size === 2
          ? this.i18n.t('tabkind.both')
          : kinds.has('screen')
            ? this.i18n.t('screen.kind')
            : this.i18n.t('tabkind.term'),
      label: !first
        ? this.i18n.t('pane.empty')
        : pos.length > 1
          ? `${first.label} +${pos.length - 1}`
          : first.label,
      title: pos.map((k) => this.fleet.keyLabel(k)).join('\n') || this.i18n.t('pane.empty'),
    };
  }

  protected closeTab(ev: Event, key: string) {
    ev.stopPropagation();
    this.tabs.close(key);
  }

  protected logout() {
    for (const t of this.tabs.list()) this.tabs.close(t.key);
    this.session.logout();
  }
}
