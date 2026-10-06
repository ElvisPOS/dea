import { Page, expect } from '@playwright/test';

export const NOW = new Date('2026-10-06T09:00:00+02:00');

export interface OpenOptions {
  scenario?: 'fleet' | 'central-only' | 'store' | 'empty' | 'big';
  theme?: 'dark' | 'light';
  lang?: 'en' | 'it';
  login?: boolean; // start on the login page
}

/** Opens the mock UI at a fixed time, so "12s ago" and the like never change between runs. */
export async function open(page: Page, o: OpenOptions = {}) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(
    ([theme, lang]) => {
      localStorage.setItem('dea.theme', JSON.stringify(theme));
      localStorage.setItem('dea.lang', JSON.stringify(lang));
    },
    [o.theme ?? 'dark', o.lang ?? 'en'],
  );
  const q = new URLSearchParams({ scenario: o.scenario ?? 'fleet', picker: '0' });
  if (o.login) q.set('login', '1');
  await page.goto(`/?${q}`);
  if (o.login) await expect(page.locator('.login-card')).toBeVisible();
  else await expect(page.locator('.rt-row').first()).toBeVisible();
}

/** A POS row by its device name (as shown in the list). */
export function row(page: Page, name: string) {
  return page.locator('.pane.on .rt-row', { has: page.locator('.rt-name', { hasText: name }) }).first();
}

/** Screenshot options: terminals are masked (their cursor blinks). */
export function shot(page: Page) {
  return { mask: [page.locator('.xterm-screen')], fullPage: false };
}
