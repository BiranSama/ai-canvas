import { defineConfig } from 'vitest/config'
import { isolatedTestRun } from './tests/helpers/test-run'

isolatedTestRun('integration')

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    pool: 'forks',
    // These tests start real runtimes and poll for finished jobs and turns for
    // up to 8 s; a cold Windows runner needs more than the 5 s default.
    testTimeout: 20_000
  }
})
