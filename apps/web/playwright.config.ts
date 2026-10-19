import { defineConfig } from '@playwright/test'

// Browser tests of the main flows and automated accessibility checks (G4), against the real server
// with the mock provider and a throwaway database. They drive the Chrome already installed on the
// machine or CI runner, so no browser is downloaded. Run `pnpm build` first: the server serves the
// built UI. The tests share one server and change its data, so they run one at a time.
export default defineConfig({
  testDir: './e2e',
  // The hosted demo has its own server and setup: playwright.demo.config.ts.
  testIgnore: ['demo/**'],
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
})
