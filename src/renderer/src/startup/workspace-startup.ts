export const WORKSPACE_STARTUP_TIMEOUT_MS = 15_000

export async function waitForWorkspaceStartup<T>(
  operation: Promise<T>,
  timeoutMs = WORKSPACE_STARTUP_TIMEOUT_MS
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('WORKSPACE_STARTUP_TIMEOUT')), timeoutMs)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}
