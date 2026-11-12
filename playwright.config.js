// Browser end-to-end tests (checkpoint 2b onwards): the real UI against a real
// server on a throwaway database, started by e2e/global-setup.js. Chromium is
// installed inside the project (node_modules), so the run needs nothing from
// outside the project folder.
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.results',
  globalSetup: require.resolve('./e2e/global-setup.js'),
  // One worker, in order: the scenarios share one server and each account has a single active session.
  workers: 1,
  fullyParallel: false,
  timeout: 180000,
  expect: { timeout: 15000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20000,
    navigationTimeout: 30000,
    trace: 'off',
    // No screenshots, not even on failure (checkpoint 2d testing rule): every state is checked by assertions.
    screenshot: 'off',
    video: 'off',
  },
});
