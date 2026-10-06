import { defineConfig } from '@playwright/test';

/**
 * UI checks on the mock server (npm run check): every screen in both themes,
 * compared with the reference screenshots in e2e/__screenshots__. After a
 * deliberate UI change, npm run check:update stores the new references.
 * Uses the installed Google Chrome (no browser download).
 */
export default defineConfig({
  testDir: 'e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  outputDir: 'e2e/results',
  fullyParallel: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  use: {
    baseURL: 'http://localhost:4300',
    channel: 'chrome',
    viewport: { width: 1440, height: 860 },
    locale: 'en-US',
    timezoneId: 'Europe/Rome',
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.005, animations: 'disabled', caret: 'hide' } },
  webServer: {
    command: 'npm run mock',
    url: 'http://localhost:4300',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
