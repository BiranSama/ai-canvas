import { defineConfig } from 'vitest/config'
import { isolatedTestRun } from './tests/helpers/test-run'

isolatedTestRun('integration')

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    pool: 'forks'
  }
})
