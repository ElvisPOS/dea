import { Component, ElementRef, HostListener, Injectable, computed, inject, signal } from '@angular/core';
import { FleetNode } from '../core/fleet.util';
import { FleetStore } from '../core/fleet-store';
import { TPipe } from '../core/i18n';
import { Tabs } from '../core/tabs';

/** The ⋯ menu of a fleet row: one menu for the whole app, placed next to its button. */
@Injectable({ providedIn: 'root' })
export class RowMenu {
  readonly open = signal<{ node: FleetNode; x: number; y: number } | null>(null);

  show(node: FleetNode, anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    this.open.set({ node, x: r.right, y: r.bottom });
  }

  close() {
    this.open.set(null);
  }
}

@Component({
  selector: 'dea-row-menu',
  imports: [TPipe],
  template: `@if (menu.open(); as m) {
    <div class="menu" role="menu" [style.left.px]="left()" [style.top.px]="top()">
      @if (m.node.kind === 'pos') {
        <button role="menuitem" [disabled]="!m.node.online" (click)="act('terminal', m.node)">{{ 'menu.terminal' | t }}</button>
        <button role="menuitem" [disabled]="!m.node.online" (click)="act('screen', m.node)">{{ 'menu.screen' | t }}</button>
        <button role="menuitem" [disabled]="!m.node.online" (click)="act('logs', m.node)">{{ 'menu.logs' | t }}</button>
      }
      <button role="menuitem" (click)="act('details', m.node)">{{ 'menu.details' | t }}</button>
      @if (removable()) {
        <hr />
        <button role="menuitem" class="is-danger" (click)="act('forget', m.node)">{{ 'agent.forget' | t }}</button>
      }
    </div>
  }`,
})
export class RowMenuView {
  protected menu = inject(RowMenu);
  protected tabs = inject(Tabs);
  protected fleet = inject(FleetStore);
  private host = inject(ElementRef<HTMLElement>);

  // keep the 180×~170 px menu inside the window
  protected left = computed(() => Math.max(8, Math.min((this.menu.open()?.x ?? 0) - 180, innerWidth - 188)));
  protected top = computed(() => {
    const y = this.menu.open()?.y ?? 0;
    return y + 180 > innerHeight ? y - 210 : y + 4;
  });

  /** Offline devices can be removed, except POS behind an offline store (the store still lists them). */
  protected removable = computed(() => {
    const n = this.menu.open()?.node;
    if (!n || n.online || n.root) return false;
    return !(n.kind === 'pos' && n.parent?.kind === 'store' && !n.parent.root && !n.parent.online);
  });

  protected act(what: 'terminal' | 'screen' | 'logs' | 'details' | 'forget', n: FleetNode) {
    this.menu.close();
    if (what === 'terminal') this.tabs.openTerminal(n.key!, n.name);
    else if (what === 'screen') this.tabs.openTerminal(n.key!, n.name, 'screen');
    else if (what === 'logs') this.tabs.openLogs(n.key!, n.name);
    else if (what === 'details') this.tabs.openDevice(n.id);
    else this.fleet.forget(n);
  }

  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent) {
    const t = ev.target as HTMLElement;
    if (!this.host.nativeElement.contains(t) && !t.closest('.rt-more')) this.menu.close();
  }

  @HostListener('document:keydown.escape')
  @HostListener('window:resize')
  onEscape() {
    this.menu.close();
  }
}
