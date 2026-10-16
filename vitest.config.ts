import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: [
            'packages/*/test/**/*.test.ts',
            'apps/server/test/**/*.test.ts',
            'apps/server/src/**/*.test.ts',
          ],
          environment: 'node',
          // Analyzer and stdio tests start git and node processes, which are slow on Windows runners.
          testTimeout: 30_000,
        },
      },
      // The web app has its own project (React transform, per-file DOM environments if needed).
      'apps/web/vitest.config.ts',
    ],
  },
})
