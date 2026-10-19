import { defineConfig } from '@playwright/test'

// Browser tests of the hosted demo mode (ADR 0019), as an anonymous visitor: no token, recorded
// presets, live runs off (no key), and the judge code. Same rules as playwright.config.ts: the
// installed Chrome, the built UI, one worker.
export default defineConfig({
  testDir: './e2e/demo',
  globalSetup: './e2e/demo/global-setup.ts',
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
