import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'

// Web unit tests. Projection, API and model logic are pure and run in node; component tests
// render to static markup, so no DOM environment is needed. A test that needs one can opt in
// per file with a `@vitest-environment` comment without affecting the node project.
export default defineProject({
  plugins: [react()],
  test: {
    name: 'web',
    root: import.meta.dirname,
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
