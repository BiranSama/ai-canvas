import { describe, expect, it } from 'vitest'
import { waitForWorkspaceStartup } from '../../src/renderer/src/startup/workspace-startup'

describe('Product 1.0 workspace startup deadline', () => {
  it('returns a completed local startup result', async () => {
    await expect(waitForWorkspaceStartup(Promise.resolve('ready'), 20)).resolves.toBe('ready')
  })

  it('turns a stalled startup into a bounded recovery signal', async () => {
    await expect(waitForWorkspaceStartup(new Promise<never>(() => undefined), 5)).rejects.toThrow('WORKSPACE_STARTUP_TIMEOUT')
  })
})
