import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { View } from './views';

/**
 * Shows a view's own element inside this host. The view (xterm or noVNC) keeps its
 * DOM and connection when it moves to another pane or tab; only its element moves.
 */
@Directive({ selector: '[deaViewHost]' })
export class ViewHost {
  readonly view = input.required<View>({ alias: 'deaViewHost' });
  private host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;

  constructor() {
    effect(() => {
      const el = this.view().el;
      if (el.parentElement !== this.host) this.host.replaceChildren(el);
      requestAnimationFrame(() => this.view().fit());
    });
  }
}
