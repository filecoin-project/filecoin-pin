import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./src/test/setup-tests.ts'],
    globals: true,
    environment: 'node',
    root: '.',
    include: ['src/**/*.test.ts'],
  },
})
