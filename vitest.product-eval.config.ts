import { defineConfig } from 'vitest/config'
import { PRODUCT_1_VITEST_FILES } from './tests/helpers/product-1-eval-catalog'
import { isolatedTestRun } from './tests/helpers/test-run'

isolatedTestRun('product-eval-integration')

export default defineConfig({
  test: {
    environment: 'node',
    include: [...PRODUCT_1_VITEST_FILES],
    maxWorkers: 1,
    pool: 'forks'
  }
})
