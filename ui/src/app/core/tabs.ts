import { Injectable, computed, inject, signal } from '@angular/core';
import { TermTab } from '../terminal/term-tab';
import { View, ViewKind, Views } from '../terminal/views';
import { storeOf } from './fleet.util';

export type Tab =
  | { key: 'fleet'; kind: 'fleet' }
  | { key: string; kind: 'device'; nodeId: string }
  | { key: string; kind: 'term'; term: TermTab }
  | { key: string; kind: 'logs'; agentKey: string; label: string };

/** The tabs of the header bar: Fleet first, then devices, terminals and logs as opened. */
@Injectable({ providedIn: 'root' })
export class Tabs {
  private views = inject(Views);
  private seq = 0;

  readonly list = signal<Tab[]>([{ key: 'fleet', kind: 'fleet' }]);
  readonly active = signal('fleet');
  readonly activeTab = computed(() => this.list().find((t) => t.key === this.active()));
  /** The terminal tab in front, if any (the header shows its layout buttons). */
  readonly activeTerm = computed(() => {
    const t = this.activeTab();
    return t?.kind === 'term' ? t.term : null;
  });

  activate(key: string) {
    this.active.set(key);
    const t = this.activeTab();
    if (t?.kind === 'term') {
      requestAnimationFrame(() => {
        t.term.fit();
        t.term.focus();
      });
    }
  }

  close(key: string) {
    const t = this.list().find((x) => x.key === key);
    if (!t || t.kind === 'fleet') return;
    if (t.kind === 'term') t.term.dispose();
    this.list.update((l) => l.filter((x) => x.key !== key));
    if (this.active() === key) this.activate(this.list()[this.list().length - 1].key);
  }

  openDevice(nodeId: string) {
    const key = `dev:${nodeId}`;
    if (!this.list().some((t) => t.key === key)) this.list.update((l) => [...l, { key, kind: 'device', nodeId }]);
    this.activate(key);
  }

  openLogs(agentKey: string, label: string) {
    const open = this.list().find((t) => t.kind === 'logs' && t.agentKey === agentKey);
    if (open) return this.activate(open.key);
    const key = `t${++this.seq}`;
    this.list.update((l) => [...l, { key, kind: 'logs', agentKey, label }]);
    this.activate(key);
  }

  private newTermTab(): TermTab {
    const key = `t${++this.seq}`;
    const term = new TermTab(key, this.views, (v) => this.spill(v), () => this.close(key));
    this.list.update((l) => [...l, { key, kind: 'term', term }]);
    this.activate(key);
    return term;
  }

  private spill(v: View) {
    const t = this.newTermTab();
    t.adopt(0, v);
  }

  /**
   * Opens a POS. In the terminal tab in front (if it holds POS of the same store):
   * the pane already showing it, else the focused empty pane. Otherwise a new tab
   * split in two, the terminal on the left and the screen on the right.
   */
  openTerminal(agentKey: string, label: string, kind: ViewKind = 'term') {
    const cur = this.activeTerm();
    if (cur && (cur.store() === null || cur.store() === storeOf(agentKey))) {
      const same = cur.slotOf(agentKey, kind);
      if (same >= 0) {
        cur.focused.set(same);
        return cur.focus();
      }
      const open = cur.slotOf(agentKey);
      if (open >= 0) return cur.showKind(open, kind);
      const free = cur.freeSlot();
      if (free >= 0) return cur.place(free, agentKey, label, kind);
    }
    const t = this.newTermTab();
    t.setLayout(2);
    t.place(0, agentKey, label, 'term');
    t.place(1, agentKey, label, 'screen');
    t.focused.set(kind === 'screen' ? 1 : 0);
    requestAnimationFrame(() => t.focus());
  }
}
