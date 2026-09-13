import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

function insideTestResults(path: string): string {
  const directory = resolve(path)
  const offset = relative(resolve('test-results'), directory)
  if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error('Test run output must be a child of this workspace test-results directory.')
  }
  return directory
}

function insideRun(root: string, path: string): string {
  const directory = insideTestResults(path)
  const offset = relative(root, directory)
  if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error('A batch and its candidate snapshots must belong to the current test run.')
  }
  return directory
}

/** One invocation owns one batch. Child workers inherit it; later invocations
 * receive a new batch, so Playwright cleanup cannot erase earlier evidence. */
export function isolatedTestRun(suite: string) {
  if (process.env.UPDATE_REFERENCE_GOLDEN === '1') {
    throw new Error('Historical reference golden updates require a separate, reviewed operation; test runs preserve them.')
  }
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const root = insideTestResults(process.env.AI_CANVAS_TEST_RUN_ROOT ?? join('test-results', 'runs', stamp))
  process.env.AI_CANVAS_TEST_RUN_ROOT = root
  const inheritedBatch = process.env.AI_CANVAS_TEST_BATCH_ROOT
  const batch = insideRun(root, inheritedBatch ?? join(root, 'batches', `${suite}-${stamp}`))
  const marker = join(batch, 'owner.json')
  let temporary: string
  if (inheritedBatch !== undefined) {
    const owner = JSON.parse(readFileSync(marker, 'utf8')) as { token: string; temporary: string }
    if (owner.token !== process.env.AI_CANVAS_TEST_BATCH_TOKEN) throw new Error('Cannot reuse another test batch output.')
    temporary = insideRun(root, owner.temporary)
  } else {
    mkdirSync(batch, { recursive: true })
    const token = randomUUID()
    // Keep native image-library paths below Windows MAX_PATH. Long test titles
    // belong in attachment paths, never in userData/project/asset paths.
    temporary = join(root, 'tmp', token.slice(0, 8))
    writeFileSync(marker, JSON.stringify({ suite, token, temporary }), { flag: 'wx' })
    process.env.AI_CANVAS_TEST_BATCH_TOKEN = token
  }
  process.env.AI_CANVAS_TEST_BATCH_ROOT = batch
  mkdirSync(temporary, { recursive: true })
  // Existing mkdtemp(tmpdir()) fixtures, Electron userData, fake vaults and
  // project libraries now stay inside this batch, on every supported OS.
  process.env.TMP = temporary
  process.env.TEMP = temporary
  process.env.TMPDIR = temporary
  Reflect.deleteProperty(process.env, 'ELECTRON_RENDERER_URL')
  delete process.env.AI_CANVAS_PACKAGED_PATH
  delete process.env.AI_CANVAS_DIAGNOSTIC_EXPORT_PATH
  const snapshots = insideRun(root, process.env.AI_CANVAS_CANDIDATE_SNAPSHOTS ?? join(root, 'candidate-snapshots'))
  return { root, batch, temporary, outputDir: join(batch, 'artifacts'), reportDir: join(batch, 'report'), snapshots }
}
