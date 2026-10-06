import { expect, test } from '@playwright/test';
import { dropFiles, open, openTerminal, row, shot } from './helpers';

// One reference screenshot per screen and state. A failing check means the
// screen changed: look at the diff in the report (npm run check:report), then
// either fix the UI or accept the change (npm run check:update).

for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test('login', async ({ page }) => {
      await open(page, { theme, login: true });
      await expect(page).toHaveScreenshot(`login-${theme}.png`);
    });

    test('fleet', async ({ page }) => {
      await open(page, { theme });
      await expect(page).toHaveScreenshot(`fleet-${theme}.png`);
    });

    test('POS overview', async ({ page }) => {
      await open(page, { theme });
      await row(page, '#2 CASSA 2 BANCO GASTRONOMIA').click();
      await expect(page.locator('.pane.on .dhead')).toContainText('#2 CASSA 2 BANCO GASTRONOMIA');
      await expect(page).toHaveScreenshot(`pos-overview-${theme}.png`);
    });

    test('terminal and screen', async ({ page }) => {
      await open(page, { theme });
      await row(page, '#3 4POS VM').locator('.rt-act').nth(1).click();
      await expect(page.locator('.screen-msg')).toContainText('VNC is not running');
      await expect(page.locator('.term-head .dot.on')).toHaveCount(1);
      await expect(page).toHaveScreenshot(`terminal-${theme}.png`, shot(page));
    });
  });
}

test('fleet in Italian', async ({ page }) => {
  await open(page, { lang: 'it' });
  await expect(page).toHaveScreenshot('fleet-it.png');
});

test('needs attention filter and collapsed store', async ({ page }) => {
  await open(page);
  await page.locator('.filter').getByText('Needs attention').click();
  await page.locator('.rt-row[data-id="s:21"] .rt-caret').click();
  await expect(page).toHaveScreenshot('fleet-attention.png');
});

test('row menu', async ({ page }) => {
  await open(page);
  await row(page, '#4 CASSA 4').locator('.rt-more').click();
  await expect(page.locator('.row-menu')).toBeVisible();
  await expect(page).toHaveScreenshot('row-menu.png');
});

test('add store or POS', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Add store or POS' }).click();
  await expect(page.locator('.add-dialog')).toBeVisible();
  await expect(page).toHaveScreenshot('add-dialog.png');
});

test('command on ticked POS', async ({ page }) => {
  await open(page);
  await page.locator('.rt-row[data-id="s:12"] .rt-check input').check();
  await expect(page.locator('.bulk')).toContainText('5 POS selected (1 offline)');
  await page.locator('.bulk input').fill('hostname');
  await page.locator('.bulk').getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('.result')).toHaveCount(5);
  await expect(page).toHaveScreenshot('command-results.png');
});

test('store overview', async ({ page }) => {
  await open(page);
  await page.locator('.rt-row[data-id="s:14"]').click();
  await expect(page.locator('.pane.on .sec-title').first()).toBeVisible();
  await expect(page).toHaveScreenshot('store-overview.png');
});

test('four panes and the store rule', async ({ page }) => {
  await open(page);
  await row(page, '#1 CASSA 1').locator('.rt-act').nth(1).click();
  await page.getByRole('button', { name: 'Four terminals' }).click();
  // empty panes offer only POS of the same store (12)
  const pick = page.locator('.term-cell').nth(2).locator('.pick');
  await pick.click();
  await expect(page.locator('.p-select-overlay .p-select-option')).toHaveText(['#1 CASSA 1', '#2 CASSA 2', '#3 4POS VM', '#3 CASSA 3 SELF']);
  // a click outside closes it (only once its opening animation has ended, so retry)
  await expect(async () => {
    await page.locator('.term-cell').nth(2).locator('.term-empty p').click();
    await expect(page.locator('.p-select-overlay')).toHaveCount(0, { timeout: 500 });
  }).toPass();
  await expect(page).toHaveScreenshot('four-panes.png', shot(page));
});

test('logs', async ({ page }) => {
  await open(page);
  await row(page, '#3 4POS VM').locator('.rt-act').nth(2).click();
  await expect(page.locator('.logs-table')).toBeVisible();
  await expect(page).toHaveScreenshot('logs.png');
});

for (const scenario of ['central-only', 'store', 'empty', 'big'] as const) {
  test(`scenario ${scenario}`, async ({ page }) => {
    await open(page, { scenario });
    await expect(page).toHaveScreenshot(`scenario-${scenario}.png`);
  });
}

test('dropping a file on a terminal', async ({ page }) => {
  await open(page);
  const cell = await openTerminal(page);
  // not masked: without focus the terminal cursor does not blink
  const still = async () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await dropFiles(page, cell, [{ name: 'price.csv', text: 'x' }], 'over');
  await expect(cell.locator('.drop-overlay')).toBeVisible();
  await still();
  await expect(page).toHaveScreenshot('upload-drop.png');
  await dropFiles(page, cell, [{ name: 'exists.txt', text: 'new' }]);
  await expect(page.locator('.confirm-dialog')).toBeVisible();
  await expect(page).toHaveScreenshot('upload-replace.png');
  await page.getByRole('button', { name: 'Replace' }).click();
  await expect(cell.locator('.upload-status.is-done')).toContainText('replaced in');
  await still();
  await expect(page).toHaveScreenshot('upload-done.png');
});
