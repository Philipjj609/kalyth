import { defineConfig } from '@playwright/test'

// Browser tests of the knowledge explorer (K5), against its own server seeded with the K3
// multi-game example, with the mock provider and a throwaway database. Like the main suite, they
// drive the installed Chrome and need `pnpm build` first. They run one at a time.
export default defineConfig({
  testDir: './e2e/knowledge',

  globalSetup: './e2e/knowledge/global-setup.ts',
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
