const { defineConfig } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

module.exports = defineConfig({
  testDir: './e2e',
  outputDir: path.join(os.tmpdir(), 'yibiao-playwright-results'),
  timeout: 30_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'npm run dev:web',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      OAUTH_MODE: 'mock',
      SESSION_SECRET: 'playwright-session-secret',
      CONFIG_ENCRYPTION_KEY: 'playwright-config-key',
    },
  },
});
