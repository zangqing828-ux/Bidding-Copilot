const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 每次运行使用独立数据目录，避免跨运行的 workspace 状态污染。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-playwright-data-'));

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
      NODE_ENV: 'test',
      SESSION_SECRET: 'playwright-session-secret',
      CONFIG_ENCRYPTION_KEY: 'playwright-config-key',
      WEB_BID_ANALYSIS_TEST_MODE: '1',
      YIBIAO_DATA_DIR: dataDir,
    },
  },
});
