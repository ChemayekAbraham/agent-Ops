import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for DashboardRedirect e2e tests.
 *
 * Run locally:
 *   bunx playwright install chromium
 *   bunx playwright test
 *
 * The webServer block boots `bun run dev` on :8080 automatically.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:8080',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});