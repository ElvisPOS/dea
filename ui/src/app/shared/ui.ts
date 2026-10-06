import { Component, computed, inject, input, ChangeDetectionStrategy } from '@angular/core';
import { Tooltip } from '@openng/optimus-ui/tooltip';
import { FleetNode, isLate, levelOf } from '../core/fleet.util';
import { I18n } from '../core/i18n';

/** Usage meter: a bar plus the number; amber at 80–89%, red at 90%+, "—" without a value. */
@Component({
  selector: 'dea-meter',
  template: `<span class="rt-meter__bar">
      @if (p() !== null) {
        <span class="rt-meter__fill" [style.width.%]="width()"></span>
      }
    </span>
    <span class="rt-meter__val">{{ p() === null ? '—' : rounded() + '%' }}</span>`,
  changeDetection: ChangeDetectionStrategy.Eager,
  host: {
    class: 'rt-meter',
    '[class.is-none]': 'p() === null',
    '[class.is-warn]': "level() === 'warn'",
    '[class.is-crit]': "level() === 'crit'",
  },
  // the tip (memory size, every disk) shows as a tooltip
  hostDirectives: [{ directive: Tooltip, inputs: ['pTooltip: tip'] }],
})
export class Meter {
  readonly p = input<number | null>(null);
  readonly tip = input<string>('');
  protected level = computed(() => (this.p() === null ? '' : levelOf(this.p()!)));
  protected width = computed(() => Math.max(2, Math.min(100, this.p() ?? 0)));
  protected rounded = computed(() => Math.round(this.p() ?? 0));
}

/** Status dot: green online, hollow offline, amber when the last report is late. */
@Component({
  selector: 'dea-dot',
  template: '',
  changeDetection: ChangeDetectionStrategy.Eager,
  host: {
    class: 'rt-dot',
    '[class.is-off]': '!node().online',
    '[class.is-stale]': 'late()',
    '[attr.title]': 'title()',
  },
})
export class Dot {
  private i18n = inject(I18n);
  readonly node = input.required<FleetNode>();
  protected late = computed(() => isLate(this.node()));
  protected title = computed(() =>
    !this.node().online
      ? this.i18n.t('dot.offline')
      : this.late()
        ? this.i18n.t('dot.late')
        : this.i18n.t('dot.online'),
  );
}

/** CENTRAL / STORE / POS badge. */
@Component({
  selector: 'dea-role',
  template: `{{ label() }}`,
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { class: 'rt-role', '[class.is-pos]': "kind() === 'pos'" },
})
export class Role {
  private i18n = inject(I18n);
  readonly kind = input.required<FleetNode['kind']>();
  protected label = computed(() => this.i18n.t(`role.${this.kind()}`));
}

/** Inline stroke icons (no icon set in the design system). */
@Component({
  selector: 'dea-icon',
  template: `@switch (name()) {
    @case ('caret') {
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path
          d="M2 3.5 5 6.5 8 3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    }
    @case ('overview') {
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
      >
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    }
    @case ('terminal') {
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 9l3 3-3 3M12 15h5" />
      </svg>
    }
    @case ('logs') {
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M6 2h9l5 5v15H6z" />
        <path d="M14 2v6h6M9 13h8M9 17h8" />
      </svg>
    }
  }`,
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { style: 'display: contents' },
})
export class Icon {
  readonly name = input.required<
    'caret' | 'overview' | 'terminal' | 'logs'
  >();
}
