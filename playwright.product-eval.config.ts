import { basename } from 'node:path'
import { defineConfig } from '@playwright/test'
import { PRODUCT_1_E2E_FILES } from './tests/helpers/product-1-eval-catalog'
import { isolatedTestRun } from './tests/helpers/test-run'

const run = isolatedTestRun('product-eval')

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: PRODUCT_1_E2E_FILES.map((file) => `**/${basename(file)}`),
  timeout: 30_000,
  retries: 0,
  workers: 1,
  outputDir: run.outputDir,
  reporter: [['list'], ['html', { open: 'never', outputFolder: run.reportDir }]],
  use: {
    trace: 'retain-on-failure'
  }
})
