import { defineConfig } from '@playwright/test'
import { isolatedTestRun } from './tests/helpers/test-run'

const run = isolatedTestRun('source-electron')

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  outputDir: run.outputDir,
  reporter: [['list'], ['html', { open: 'never', outputFolder: run.reportDir }]],
  use: {
    trace: 'retain-on-failure'
  }
})
