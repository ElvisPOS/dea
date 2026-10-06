import { Component, computed, inject, input, output } from '@angular/core';
import { FleetStore } from '../core/fleet-store';
import { I18n, TPipe } from '../core/i18n';
import { ExecResult } from '../core/models';

/** Results of a command run from the command bar, failures first. */
@Component({
  selector: 'dea-exec-results',
  imports: [TPipe],
  host: { class: 'panel' },
  template: `<div class="panel-head">
      <h2>{{ 'exec.resultsTitle' | t }}</h2>
      <code>{{ cmd() }}</code>
      <span class="muted small">{{ summary() }}</span>
      <span class="spacer"></span>
      <button class="rt-btn is-ghost" (click)="closed.emit()">{{ 'dialog.close' | t }}</button>
    </div>
    <div class="results">
      @if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (!results()) {
        <p class="muted">{{ 'exec.running' | t: { n: count() } }}</p>
      } @else {
        @for (r of results(); track r.id) {
          <div class="result">
            <div class="result-head">
              <b>{{ fleet.keyLabel(r.id) }}</b>
              <span [class]="r.ok && r.code === 0 ? 'ok' : 'fail'">{{ r.ok ? ('exec.exit' | t: { code: r.code }) : ('exec.failed' | t) }}</span>
              <span class="muted">{{ r.ms ? r.ms + ' ms' : '' }}</span>
            </div>
            <pre>{{ text(r) }}</pre>
          </div>
        }
      }
    </div>`,
})
export class ExecResults {
  protected fleet = inject(FleetStore);
  private i18n = inject(I18n);

  readonly cmd = input.required<string>();
  readonly results = input<ExecResult[] | null>(null);
  readonly error = input<string | undefined>();
  readonly count = input(0);
  readonly closed = output();

  protected summary = computed(() => {
    const r = this.results();
    return r ? this.i18n.t('exec.succeeded', { ok: r.filter((x) => x.ok && x.code === 0).length, n: r.length }) : '';
  });

  protected text(r: ExecResult) {
    return (r.output || '') + (r.error ? (r.output ? '\n' : '') + this.i18n.t('exec.error', { msg: this.i18n.err(r.error) }) : '');
  }
}
