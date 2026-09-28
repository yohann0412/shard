import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'dot' : 'list',
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000', trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node dist/server.js', url: 'http://localhost:3000/health', reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
