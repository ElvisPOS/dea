import { Component, ChangeDetectionStrategy } from '@angular/core';
import { TPipe } from '../core/i18n';

/** Column headers of the fleet list (same grid as the rows). */
@Component({
  selector: 'dea-list-head',
  imports: [TPipe],
  host: { class: 'rt-grid rt-head', role: 'row' },
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `<span></span>
    <span>{{ 'col.device' | t }}</span>
    <span>{{ 'col.cpu' | t }}</span>
    <span>{{ 'col.mem' | t }}</span>
    <span>{{ 'col.disk' | t }}</span>
    <span class="is-num">{{ 'col.load' | t }}</span>
    <span class="is-num">{{ 'col.uptime' | t }}</span>
    <span class="is-num">{{ 'col.reported' | t }}</span>
    <span></span>
    <span></span>`,
})
export class ListHead {}
