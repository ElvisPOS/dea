import { Injectable, effect, signal } from '@angular/core';
import type { ITheme } from '@xterm/xterm';
import { loadPref, savePref } from './prefs';

export type ThemeName = 'dark' | 'light';

// xterm colours per UI theme; the light one keeps ANSI colours readable on white.
const TERM_THEMES: Record<ThemeName, ITheme> = {
  dark: { background: '#0f1216', foreground: '#e6e9ee', cursor: '#5b9bff', cursorAccent: '#0f1216', selectionBackground: '#1b2a40' },
  light: {
    background: '#ffffff', foreground: '#1f2328', cursor: '#0969da', cursorAccent: '#ffffff', selectionBackground: '#b6d7f7',
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#9a6700', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
};

/** Light/dark theme (dark by default, remembered per browser): sets data-theme on <html>. */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly name = signal<ThemeName>(loadPref<string>('dea.theme', 'dark') === 'light' ? 'light' : 'dark');

  constructor() {
    effect(() => {
      const light = this.name() === 'light';
      if (light) document.documentElement.dataset['theme'] = 'light';
      else delete document.documentElement.dataset['theme'];
      savePref('dea.theme', this.name());
    });
  }

  toggle() {
    this.name.update((n) => (n === 'light' ? 'dark' : 'light'));
  }

  terminal(): ITheme {
    return TERM_THEMES[this.name()];
  }
}
