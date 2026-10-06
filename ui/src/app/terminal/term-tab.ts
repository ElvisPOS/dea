import { signal } from '@angular/core';
import { storeOf } from '../core/fleet.util';
import { View, ViewKind, Views } from './views';

/**
 * A terminal tab: 1–4 panes, each showing the terminal or the screen of a POS of
 * one store. Panes sit on a grid split by two ratios (cx between the columns, cy
 * between the rows) that the dividers drag; × removes a pane and the others grow.
 */
export class TermTab {
  readonly slots = signal<(View | null)[]>([null]);
  readonly focused = signal(0);
  readonly cx = signal(0.5);
  readonly cy = signal(0.5);
  /** "Type in all": keystrokes go to every connected terminal of the tab. */
  readonly sync = signal(false);

  constructor(
    readonly key: string,
    private factory: Views,
    /** Moves a view that no longer fits into a tab of its own. */
    private spill: (v: View) => void,
    /** Closes this tab (its last pane was removed). */
    private closeTab: () => void,
  ) {}

  layout() {
    return this.slots().length;
  }

  views(): View[] {
    return this.slots().filter((v): v is View => !!v);
  }

  shells() {
    return this.views().filter((v) => v.kind === 'term');
  }

  /** The store whose POS this tab may show (that of its first POS), or null while empty. */
  store(): string | null {
    const v = this.views()[0];
    return v ? storeOf(v.agentKey) : null;
  }

  kindOf(v: View): ViewKind {
    return v.kind;
  }

  /** Pane a newly opened POS should go to, or -1 when full. */
  freeSlot() {
    const s = this.slots();
    if (!s[this.focused()]) return this.focused();
    return s.findIndex((v) => !v);
  }

  /** The pane showing a POS (as "term" or "screen" when kind is given), or -1. */
  slotOf(agentKey: string, kind?: ViewKind) {
    return this.slots().findIndex((v) => v && v.agentKey === agentKey && (!kind || v.kind === kind));
  }

  private wire(v: View) {
    if (v.kind === 'term') {
      v.onInput = (src, data) => {
        if (!this.sync()) return src.send(data);
        for (const x of this.shells()) x.send(data);
      };
    }
  }

  private setSlot(i: number, v: View | null) {
    this.slots.update((s) => s.map((x, j) => (j === i ? v : x)));
  }

  adopt(i: number, v: View) {
    this.wire(v);
    if (v.twin) this.wire(v.twin);
    this.setSlot(i, v);
    this.focused.set(i);
    requestAnimationFrame(() => v.focus());
  }

  place(i: number, agentKey: string, label: string, kind: ViewKind = 'term') {
    const v = this.factory.create(kind, agentKey, label);
    this.adopt(i, v);
    v.connect();
  }

  /**
   * Shows the terminal or the screen of the POS in pane i. If another pane already
   * shows it, the two panes swap; otherwise the other view stays connected in the
   * background (the pane's twin), so switching back is instant.
   */
  showKind(i: number, kind: ViewKind) {
    const s = this.slots();
    const v = s[i];
    if (!v || v.kind === kind) return;
    const j = s.findIndex((x, k) => k !== i && x && x.agentKey === v.agentKey && x.kind === kind);
    let w: View;
    if (j >= 0) {
      w = s[j]!;
      this.slots.update((arr) => arr.map((x, k) => (k === i ? w : k === j ? v : x)));
    } else if (v.twin) {
      w = v.twin;
      this.setSlot(i, w);
    } else {
      w = this.factory.create(kind, v.agentKey, v.label);
      w.twin = v;
      v.twin = w;
      this.wire(w);
      this.setSlot(i, w);
      w.connect();
    }
    this.focused.set(i);
    if (this.shells().length < 2) this.sync.set(false);
    requestAnimationFrame(() => w.focus());
  }

  /** Sets the number of panes: new ones start empty; extra views move to new tabs. */
  setLayout(n: number) {
    const cur = this.slots();
    if (n === cur.length) return;
    if (n > cur.length) {
      this.slots.set([...cur, ...Array(n - cur.length).fill(null)]);
    } else {
      const vs = this.views();
      const keep: (View | null)[] = vs.slice(0, n);
      while (keep.length < n) keep.push(null);
      this.slots.set(keep);
      for (const v of vs.slice(n)) this.spill(v);
    }
    this.focused.set(Math.min(this.focused(), n - 1));
    if (this.shells().length < 2) this.sync.set(false);
  }

  setSync(on: boolean) {
    this.sync.set(on && this.shells().length > 1);
    this.focus();
  }

  /** Closes the view in pane i and removes the pane (the last pane closes the tab). */
  closeSlot(i: number) {
    const v = this.slots()[i];
    v?.twin?.close();
    v?.close();
    if (this.layout() === 1) return this.closeTab();
    this.slots.update((s) => s.filter((_, j) => j !== i));
    const f = this.focused();
    this.focused.set(Math.min(f > i ? f - 1 : f, this.layout() - 1));
    if (this.shells().length < 2) this.sync.set(false);
    this.focus();
  }

  /** Pane rectangles as fractions [x, y, w, h]: 2 side by side, 3 = one left and two stacked, 4 = 2×2. */
  rects(): [number, number, number, number][] {
    const cx = this.cx(), cy = this.cy();
    const all: [number, number, number, number][][] = [
      [[0, 0, 1, 1]],
      [[0, 0, cx, 1], [cx, 0, 1 - cx, 1]],
      [[0, 0, cx, 1], [cx, 0, 1 - cx, cy], [cx, cy, 1 - cx, 1 - cy]],
      [[0, 0, cx, cy], [cx, 0, 1 - cx, cy], [0, cy, cx, 1 - cy], [cx, cy, 1 - cx, 1 - cy]],
    ];
    return all[this.layout() - 1];
  }

  fit() {
    for (const v of this.views()) v.fit();
  }

  focus() {
    (this.slots()[this.focused()] || this.views()[0])?.focus();
  }

  /** Closes every view (when the tab closes). */
  dispose() {
    for (const v of this.views()) {
      v.twin?.close();
      v.close();
    }
  }
}
