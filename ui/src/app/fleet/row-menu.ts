import { Component, Injectable, computed, inject, signal, viewChild, ChangeDetectionStrategy } from '@angular/core';
import { MenuItem } from '@openng/optimus-ui/api';
import { Menu, MenuModule } from '@openng/optimus-ui/menu';
import { FleetNode } from '../core/fleet.util';
import { FleetStore } from '../core/fleet-store';
import { I18n } from '../core/i18n';
import { Tabs } from '../core/tabs';

/** The ⋯ menu of a fleet row: one popup menu for the whole app, opened next to its button. */
@Injectable({ providedIn: 'root' })
export class RowMenu {
  readonly node = signal<FleetNode | null>(null);
  /** Set by the menu view; opens it at the clicked button. */
  open?: (ev: Event) => void;

  show(node: FleetNode, ev: Event) {
    this.node.set(node);
    this.open?.(ev);
  }
}

@Component({
  selector: 'dea-row-menu',
  imports: [MenuModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `<p-menu #menu [popup]="true" [model]="items()" appendTo="body" styleClass="row-menu" />`,
})
export class RowMenuView {
  private menu = inject(RowMenu);
  private tabs = inject(Tabs);
  private fleet = inject(FleetStore);
  private i18n = inject(I18n);
  private view = viewChild.required<Menu>('menu');

  constructor() {
    this.menu.open = (ev) => this.view().toggle(ev);
  }

  /** Offline devices can be removed, except POS behind an offline store (the store still lists them). */
  private removable(n: FleetNode) {
    if (n.online || n.root) return false;
    return !(n.kind === 'pos' && n.parent?.kind === 'store' && !n.parent.root && !n.parent.online);
  }

  protected items = computed<MenuItem[]>(() => {
    const n = this.menu.node();
    if (!n) return [];
    const t = (k: string) => this.i18n.t(k);
    const items: MenuItem[] = [];
    if (n.kind === 'pos') {
      items.push(
        { label: t('menu.terminal'), disabled: !n.online, command: () => this.tabs.openTerminal(n.key!, n.name) },
        { label: t('menu.screen'), disabled: !n.online, command: () => this.tabs.openTerminal(n.key!, n.name, 'screen') },
        { label: t('menu.logs'), disabled: !n.online, command: () => this.tabs.openLogs(n.key!, n.name) },
      );
    }
    items.push({ label: t('menu.details'), command: () => this.tabs.openDevice(n.id) });
    if (this.removable(n)) {
      items.push({ separator: true }, { label: t('agent.forget'), styleClass: 'is-danger', command: () => this.fleet.forget(n) });
    }
    return items;
  });
}
