import { defineConfig } from '@playwright/test'
import { isolatedTestRun } from './tests/helpers/test-run'

const run = isolatedTestRun('product-reliability')

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/product-1-f-startup-resilience.spec.ts',
  timeout: 300_000,
  retries: 0,
  workers: 1,
  outputDir: run.outputDir,
  reporter: [['list'], ['html', { open: 'never', outputFolder: run.reportDir }]],
  use: {
    trace: 'retain-on-failure'
  }
})
