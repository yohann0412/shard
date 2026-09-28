import { defineConfig } from '@playwright/test';
console.error(`[repo-config] pid=${process.pid} TEST_PARALLEL_INDEX=${process.env.TEST_PARALLEL_INDEX} BASE_URL=${process.env.BASE_URL}`);
export default defineConfig({
  testDir: './tests',
  workers: 1,
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3999' },
  webServer: { command: 'node -e "process.exit(1)"', url: 'http://localhost:3999', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
