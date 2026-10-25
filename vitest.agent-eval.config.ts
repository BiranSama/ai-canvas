import { defineConfig } from 'vitest/config'
import { isolatedTestRun } from './tests/helpers/test-run'

// Manual real-model agent eval (`pnpm eval:agent`); not matched by any CI suite.
isolatedTestRun('agent-eval')

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/agent-eval/**/*.eval.ts'],
    maxWorkers: 1,
    pool: 'forks',
    testTimeout: 12 * 60 * 60_000,
    hookTimeout: 60_000
  }
})
