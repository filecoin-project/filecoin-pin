import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    projects: [
      {
        // unit tests for node.js (also isomorphic tests)
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/test/unit/**/*.test.ts', 'src/test/**/*.iso.test.ts'],
          exclude: ['src/test/**/*.browser.test.ts'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
      {
        // integration tests
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/test/integration/**/*.test.ts'],
          exclude: ['src/test/**/*.browser.test.ts'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
      {
        // browser tests (also isomorphic tests)
        test: {
          name: 'browser',
          include: ['src/test/**/*.browser.test.ts', 'src/test/**/*.iso.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            headless: true,
            screenshotFailures: false,
          },
        },
      },
    ],
  },
})
