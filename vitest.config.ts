import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: { DATABASE_PATH: ':memory:', NODE_ENV: 'test' },
    // Each test file gets its own DATA_DIR.
    setupFiles: ['src/server/test/data-dir.ts'],
    testTimeout: 20000,
    // Some setups build many PDFs and hash passwords, which is slow under full parallel load.
    hookTimeout: 60000,
  },
})
