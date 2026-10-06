import { expect, test } from '@playwright/test';
import { dropFiles, open, openTerminal, row } from './helpers';

// What the UI must do, independently of how it looks.

test('search keeps a matching POS under its store and central', async ({ page }) => {
  await open(page);
  await page.getByPlaceholder('Search store, POS, host, IP, ID…').fill('gastronomia');
  await expect(page.locator('.pane.on .rt-row .rt-name')).toHaveText(['Central server', '001712 AMACO Pordenone Centro', '#2 CASSA 2 BANCO GASTRONOMIA']);
});

test('summary tiles count the fleet', async ({ page }) => {
  await open(page);
  const tiles = page.locator('.rt-kpi b');
  await expect(tiles).toHaveText(['3/4', '9/12', '4', '1', '5']);
});

test('keyboard: arrows move, space ticks, enter opens', async ({ page }) => {
  await open(page);
  await row(page, '#1 CASSA 1').focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, '#2 CASSA 2')).toBeFocused();
  await page.keyboard.press(' ');
  await expect(page.locator('.bulk')).toContainText('1 POS selected');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab.on')).toContainText('#2 CASSA 2');
});

test('opening a POS of another store starts a new terminal tab', async ({ page }) => {
  await open(page);
  await row(page, '#1 CASSA 1').locator('.rt-act').nth(1).click();
  await page.locator('.tab', { hasText: 'Fleet' }).click();
  await page.locator('.rt-row[data-id="p:21/memphis-pos-302"] .rt-act').nth(1).click();
  await expect(page.locator('.tab .tab-kind', { hasText: 'TERMINAL + SCREEN' })).toHaveCount(2);
});

test('removing a pane, then the last pane closes the tab', async ({ page }) => {
  await open(page);
  await row(page, '#3 4POS VM').locator('.rt-act').nth(1).click();
  await expect(page.locator('.term-cell')).toHaveCount(2);
  await page.locator('.term-cell').nth(1).locator('.term-head-close').click();
  await expect(page.locator('.term-cell')).toHaveCount(1);
  await page.locator('.term-head-close').click();
  await expect(page.locator('.tab')).toHaveCount(1);
});

test('the mock shell answers commands', async ({ page }) => {
  await open(page);
  await row(page, '#3 4POS VM').locator('.rt-act').nth(1).click();
  await expect(page.locator('.term-head .dot.on')).toHaveCount(1);
  await page.locator('.xterm-helper-textarea').first().pressSequentially('hostname\n');
  await expect(page.locator('.xterm-rows').first()).toContainText('memphis-pos-169');
});

test('login and wrong password', async ({ page }) => {
  await open(page, { login: true });
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.login-card .error')).toHaveText('wrong user or password');
  await page.getByLabel('Password').fill('pw');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.rt-row').first()).toBeVisible();
});

test('the disk tooltip lists every mount', async ({ page }) => {
  await open(page);
  await row(page, '#1 CASSA 1').locator('dea-meter').nth(2).hover();
  await expect(page.locator('.p-tooltip')).toContainText('/boot  95% of 471 MB');
});

test('the row menu opens the overview and offers removal for offline POS', async ({ page }) => {
  await open(page);
  await row(page, '#4 CASSA 4').locator('.rt-more').click();
  await expect(page.locator('.row-menu')).toContainText('Remove from list');
  await page.locator('.row-menu').getByText('Overview').click();
  await expect(page.locator('.tab.on')).toContainText('#4 CASSA 4');
});

test('a file dropped on a terminal is uploaded to its folder', async ({ page }) => {
  await open(page);
  const cell = await openTerminal(page);
  await dropFiles(page, cell, [{ name: 'price.csv', text: 'code;price\n1;2.50\n' }]);
  await expect(cell.locator('.upload-status')).toContainText('price.csv uploaded to /home/elvispos');
  await page.locator('.xterm-helper-textarea').first().pressSequentially('ls\n');
  await expect(page.locator('.xterm-rows').first()).toContainText('price.csv');
});

test('uploading asks before replacing a file', async ({ page }) => {
  await open(page);
  const cell = await openTerminal(page);
  await dropFiles(page, cell, [{ name: 'exists.txt', text: 'new' }]);
  await expect(page.locator('.confirm-dialog')).toContainText('/home/elvispos/exists.txt already exists on the POS');
  await page.getByRole('button', { name: 'Keep the old one' }).click();
  await expect(cell.locator('.upload-status')).toContainText('the file on the POS was kept');

  await dropFiles(page, cell, [{ name: 'exists.txt', text: 'new' }]);
  await page.getByRole('button', { name: 'Replace' }).click();
  await expect(cell.locator('.upload-status')).toContainText('exists.txt uploaded to /home/elvispos');
});

test('upload errors from the POS are shown', async ({ page }) => {
  await open(page, { lang: 'it' });
  const cell = await openTerminal(page);
  await dropFiles(page, cell, [{ name: 'noperm.txt', text: 'x' }]);
  await expect(cell.locator('.upload-status.is-error')).toContainText('nessun permesso di scrittura in /home/elvispos');
});

test('the Upload button sends several files', async ({ page }) => {
  await open(page);
  const cell = await openTerminal(page);
  await cell.locator('input[type=file]').setInputFiles([
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: 'b.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(600 << 10) },
  ]);
  await expect(cell.locator('.upload-status')).toContainText('b.bin uploaded to /home/elvispos (600 KB)');
  await expect(cell.locator('.upload-status')).toContainText('2 of 2');
});
