import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { isolatedTestRun } from './tests/helpers/test-run'

const run = isolatedTestRun('unit')

export default defineConfig({
  plugins: [react()],
  test: {
    maxWorkers: 2,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    coverage: {
      reportsDirectory: `${run.batch}/coverage`,
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}']
    }
  }
})
