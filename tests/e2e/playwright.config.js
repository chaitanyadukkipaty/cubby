import { defineConfig, devices } from '@playwright/test';

// Browser journeys only: the top of the pyramid. Logic is covered by tests/unit and tests/integration.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  globalSetup: './global-setup.js',
  // One shared server; tests change server-wide settings (signup code, limits), so run them in order.
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 1 : 0,
  outputDir: '../../test-results',
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]]
    : [['list']],
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
