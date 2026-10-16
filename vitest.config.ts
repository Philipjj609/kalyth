import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    // Analyzer and stdio tests start git and node processes, which are slow on Windows runners.
    testTimeout: 30_000,
  },
})
