import { Injectable, Pipe, PipeTransform, effect, inject, signal } from '@angular/core';
import { I18N, I18N_ERRORS } from './i18n.dict';
import { loadPref, savePref } from './prefs';

export type Lang = 'en' | 'it';
export const LANGS: Lang[] = ['en', 'it'];

/** UI language (English by default, remembered per browser) and the text lookups. */
@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<Lang>(LANGS.includes(loadPref<Lang>('dea.lang', 'en')) ? loadPref<Lang>('dea.lang', 'en') : 'en');

  constructor() {
    effect(() => {
      document.documentElement.lang = this.lang();
      savePref('dea.lang', this.lang());
    });
  }

  /** Text for key with {vars} filled in; "<key>.one" is used when vars.n is 1. */
  t(key: string, vars: Record<string, unknown> = {}): string {
    const dict = I18N[this.lang()] ?? I18N['en'];
    if (vars['n'] === 1 && (dict[key + '.one'] ?? I18N['en'][key + '.one'])) key += '.one';
    const s = dict[key] ?? I18N['en'][key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
  }

  /** Translates a server error message (exact, or by its known prefix). */
  err(msg: string): string {
    const map = I18N_ERRORS[this.lang()];
    if (!map || !msg) return msg;
    if (map[msg]) return map[msg];
    for (const [from, to] of Object.entries(map)) {
      if (from.endsWith(' ') && msg.startsWith(from)) return to + msg.slice(from.length);
    }
    return msg;
  }

  /** "5s", "3m", "2h", "4d" since an ISO time. */
  ago(iso?: string | null): string {
    if (!iso || iso.startsWith('0001')) return this.t('time.never');
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}${this.t('unit.s')}`;
    if (s < 3600) return `${Math.floor(s / 60)}${this.t('unit.m')}`;
    if (s < 86400) return `${Math.floor(s / 3600)}${this.t('unit.h')}`;
    return `${Math.floor(s / 86400)}${this.t('unit.d')}`;
  }

  /** "12d 4h", "3h 10m", "24m" for a number of seconds. */
  duration(sec: number): string {
    if (!sec) return '–';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}${this.t('unit.d')} ${h}${this.t('unit.h')}`;
    if (h) return `${h}${this.t('unit.h')} ${m}${this.t('unit.m')}`;
    return `${m}${this.t('unit.m')}`;
  }
}

/** {{ 'key' | t }} or {{ 'key' | t: { n: 3 } }}; follows language changes. */
@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private i18n = inject(I18n);
  transform(key: string, vars?: Record<string, unknown>): string {
    return this.i18n.t(key, vars);
  }
}
