const { defineConfig } = require('@playwright/test');
const os = require('node:os');
const path = require('node:path');

const playwrightDataDir = path.join(os.tmpdir(), `yibiao-playwright-data-${process.pid}`);

module.exports = defineConfig({
  testDir: './e2e',
  outputDir: path.join(__dirname, 'test-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(__dirname, 'playwright-report'), open: 'never' }],
  ],
  timeout: 120_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    headless: true,
    trace: 'on',
  },
  webServer: {
    command: 'npm run dev:web',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      OAUTH_MODE: 'mock',
      NODE_ENV: 'test',
      SESSION_SECRET: 'playwright-session-secret',
      CONFIG_ENCRYPTION_KEY: 'playwright-config-key',
      YIBIAO_DATA_DIR: playwrightDataDir,
      WEB_BID_ANALYSIS_TEST_MODE: '1',
      WEB_BID_ANALYSIS_TEST_CONTENT_DELAY_MS: '3000',
    },
  },
});
