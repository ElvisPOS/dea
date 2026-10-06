import { Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { agentName, compareAgents, keyOf, storeOf } from '../core/fleet.util';
import { FleetStore } from '../core/fleet-store';
import { I18n, TPipe } from '../core/i18n';
import { TermTab } from './term-tab';
import { ViewHost } from './view-host';
import { ScreenSession, View, ViewKind } from './views';

const GAP = 2; // half the gap between panes, px

/** A terminal tab: its panes, the dividers between them and each pane's header. */
@Component({
  selector: 'dea-term-tab',
  imports: [FormsModule, ViewHost, TPipe],
  templateUrl: './term-tab-view.html',
  host: {
    class: 'term-tab',
    '[class.sync]': 'tab().sync()',
    '[class.resizing]': 'resizing()',
    '[class.split-1]': 'tab().layout() === 1',
  },
})
export class TermTabView {
  protected fleet = inject(FleetStore);
  protected i18n = inject(I18n);
  private host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;

  readonly tab = input.required<TermTab>();
  protected resizing = signal(false);
  protected password = signal('');

  /** Pane boxes in CSS (percent of the tab, minus the gap between panes). */
  protected boxes = computed(() => {
    const g = this.tab().layout() > 1 ? GAP : 0;
    return this.tab()
      .rects()
      .map(([x, y, w, h]) => ({
        left: `calc(${x * 100}% + ${g}px)`,
        top: `calc(${y * 100}% + ${g}px)`,
        width: `calc(${w * 100}% - ${2 * g}px)`,
        height: `calc(${h * 100}% - ${2 * g}px)`,
      }));
  });

  /** POS the empty panes may open: online, and of this tab's store once it has one. */
  protected choices = computed(() => {
    const only = this.tab().store();
    const coll = new Intl.Collator(this.i18n.lang(), { numeric: true, sensitivity: 'base' });
    const agents = this.fleet
      .data()
      .agents.filter((a) => a.online && (only === null || storeOf(keyOf(a)) === only))
      .sort((a, b) => compareAgents(a, b, this.fleet.sort(), coll));
    const groups = new Map<string, { key: string; name: string }[]>();
    for (const a of agents) {
      const g = a.store ? this.fleet.storeName(a.store) || a.store : this.fleet.tree().name;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push({ key: keyOf(a), name: agentName(a) });
    }
    return [...groups].map(([group, items]) => ({ group, items }));
  });

  protected emptyHint = computed(() => {
    const only = this.tab().store();
    if (only === null) return this.i18n.t('pane.hint');
    return this.i18n.t('pane.hintStore', { store: this.fleet.storeName(only) || only || this.fleet.tree().name });
  });

  protected isScreen(v: View): v is ScreenSession {
    return v.kind === 'screen';
  }

  protected open(i: number, key: string, kind: ViewKind) {
    const a = this.fleet.data().agents.find((x) => keyOf(x) === key);
    if (a) this.tab().place(i, key, agentName(a), kind);
  }

  protected submitPassword(v: ScreenSession, ev: Event) {
    ev.preventDefault();
    v.sendPassword(this.password());
    this.password.set('');
  }

  /** Drag a divider to resize; double-click it to split evenly again. */
  protected drag(axis: 'v' | 'h', ev: PointerEvent) {
    ev.preventDefault();
    const bar = ev.target as HTMLElement;
    bar.setPointerCapture(ev.pointerId);
    this.resizing.set(true);
    const box = this.host.getBoundingClientRect();
    const sig = axis === 'v' ? this.tab().cx : this.tab().cy;
    const move = (e: PointerEvent) => {
      const r = axis === 'v' ? (e.clientX - box.left) / box.width : (e.clientY - box.top) / box.height;
      sig.set(Math.min(0.85, Math.max(0.15, r)));
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener(
      'pointerup',
      () => {
        bar.removeEventListener('pointermove', move);
        this.resizing.set(false);
        this.tab().fit();
      },
      { once: true },
    );
  }

  protected resetSplit(axis: 'v' | 'h') {
    (axis === 'v' ? this.tab().cx : this.tab().cy).set(0.5);
    requestAnimationFrame(() => this.tab().fit());
  }
}
