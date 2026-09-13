import { defineConfig } from '@playwright/test'
import { isolatedTestRun } from './tests/helpers/test-run'

const run = isolatedTestRun('product-security')

const PRODUCT_SECURITY_E2E_FILES = [
  'credential-security.spec.ts',
  'provider-budget.spec.ts',
  'provider-protocol-settings.spec.ts',
  'diagnostic-export.spec.ts'
] as const

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: PRODUCT_SECURITY_E2E_FILES.map((file) => `**/${file}`),
  timeout: 30_000,
  retries: 0,
  workers: 1,
  outputDir: run.outputDir,
  reporter: [['list'], ['html', { open: 'never', outputFolder: run.reportDir }]],
  use: {
    trace: 'retain-on-failure'
  }
})
