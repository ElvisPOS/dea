import { Locator, Page, expect } from '@playwright/test';

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

/** Drops files (name and text content) on an element, as dragging them from the desktop does. */
export async function dropFiles(page: Page, target: Locator, files: { name: string; text: string }[], only: 'over' | 'drop' = 'drop') {
  const dt = await page.evaluateHandle((fs) => {
    const d = new DataTransfer();
    for (const f of fs) d.items.add(new File([f.text], f.name));
    return d;
  }, files);
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  if (only === 'drop') await target.dispatchEvent('drop', { dataTransfer: dt });
}

/** Opens the 4POS VM terminal (mock) and waits for its prompt. */
export async function openTerminal(page: Page) {
  await row(page, '#3 4POS VM').locator('.rt-act').nth(1).click();
  await expect(page.locator('.term-head .dot.on')).toHaveCount(1);
  return page.locator('.term-cell').first();
}
