import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserMemoryStore } from '../../src/main/user/user-memory-store'
import { SIGNALS_PER_SUMMARY } from '../../src/shared/user-memory'

let root: string
let file: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'user-memory-'))
  file = join(root, 'state', 'user-memory.json')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function png(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer())
}

describe('user memory store', () => {
  it('starts empty, saves the brand and reads it back from a new store', async () => {
    const store = new UserMemoryStore(file)
    expect((await store.snapshot()).brand).toMatchObject({ name: '', colors: [], logo: null })
    await store.saveBrand({ name: '晨雾咖啡', colors: ['#3B6FB6'], titleFont: 'Noto Serif SC', bodyFont: '', copy: ['每天新鲜烘焙'], bannedWords: ['最'] })
    const again = new UserMemoryStore(file)
    expect((await again.read()).brand).toMatchObject({ name: '晨雾咖啡', colors: ['#3B6FB6'], titleFont: 'Noto Serif SC', copy: ['每天新鲜烘焙'], bannedWords: ['最'] })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('sets an unreadable file aside and starts fresh', async () => {
    await new UserMemoryStore(file).saveBrand({ name: 'x', colors: [], titleFont: '', bodyFont: '', copy: [], bannedWords: [] })
    await writeFile(file, '{ not json', 'utf8')
    const store = new UserMemoryStore(file)
    expect((await store.read()).brand.name).toBe('')
    expect((await readdir(join(root, 'state'))).some((name) => name.startsWith('user-memory.json.unreadable-'))).toBe(true)
  })

  it('keeps one logo file, replaces it, and removes it with the logo', async () => {
    const store = new UserMemoryStore(file)
    await store.setLogo({ mimeType: 'image/png', bytes: await png(400, 100) })
    const first = (await store.read()).brand.logo
    expect(first).toMatchObject({ mimeType: 'image/png', width: 400, height: 100 })
    expect((await store.snapshot()).logoPreview).toMatch(/^data:image\/png;base64,/)
    await store.setLogo({ mimeType: 'image/png', bytes: await png(50, 50) })
    expect(await readdir(join(root, 'brand'))).toEqual([(await store.read()).brand.logo!.fileName])
    await store.clearLogo()
    expect((await store.read()).brand.logo).toBeNull()
    expect(await readdir(join(root, 'brand'))).toEqual([])
    await expect(store.setLogo({ mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) })).rejects.toThrow('读不出来')
  })

  it('adds, edits, turns off and removes preferences', async () => {
    const store = new UserMemoryStore(file)
    await store.change({ action: 'add', kind: 'preference', content: '版面留白多一些' })
    const [entry] = (await store.read()).memories
    expect(entry).toMatchObject({ kind: 'preference', content: '版面留白多一些', source: 'user', enabled: true })
    await store.change({ action: 'edit', id: entry!.id, kind: 'fact', content: '店在杭州' })
    await store.change({ action: 'enable', id: entry!.id, enabled: false })
    expect((await store.read()).memories[0]).toMatchObject({ kind: 'fact', content: '店在杭州', enabled: false })
    await store.change({ action: 'remove', id: entry!.id })
    expect((await store.read()).memories).toEqual([])
  })

  it('offers a candidate once and files it only when confirmed', async () => {
    const store = new UserMemoryStore(file)
    const candidate = await store.propose('preference', '标题喜欢用衬线体', 'agent')
    expect(candidate).toMatchObject({ status: 'pending', source: 'agent' })
    expect(await store.propose('preference', ' 标题喜欢用衬线体 ', 'learned')).toBeNull()
    expect((await store.read()).memories).toEqual([])
    await store.change({ action: 'confirm', id: candidate!.id })
    const confirmed = await store.read()
    expect(confirmed.memories).toEqual([expect.objectContaining({ content: '标题喜欢用衬线体', source: 'agent', enabled: true })])
    expect(confirmed.candidates[0]!.status).toBe('confirmed')
    // An ignored one is not offered again either.
    const other = await store.propose('preference', '喜欢暖色', 'learned')
    await store.change({ action: 'ignore', id: other!.id })
    expect(await store.propose('preference', '喜欢暖色', 'learned')).toBeNull()
  })

  it('says a summary is due after enough signals, and starts counting again once summed up', async () => {
    const store = new UserMemoryStore(file)
    for (let index = 1; index < SIGNALS_PER_SUMMARY; index += 1) expect(await store.recordSignal('said', `第 ${index} 条`)).toBe(false)
    expect(await store.recordSignal('said', '最后一条')).toBe(true)
    const added = await store.summarized([{ kind: 'preference', content: '喜欢简洁' }, { kind: 'preference', content: '' }])
    expect(added.map((entry) => entry.content)).toEqual(['喜欢简洁'])
    const learned = await store.read()
    expect(learned.learning.newSignals).toBe(0)
    expect(learned.learning.lastSummaryAt).not.toBeNull()
    expect(learned.candidates[0]).toMatchObject({ source: 'learned', status: 'pending' })
  })

  it('records no signals while learning is off, and clears them on request', async () => {
    const store = new UserMemoryStore(file)
    await store.recordSignal('said', '太花了')
    await store.change({ action: 'learning', enabled: false })
    await store.recordSignal('said', '要简洁')
    expect((await store.read()).signals.map((signal) => signal.text)).toEqual(['太花了'])
    await store.change({ action: 'clear-signals' })
    expect((await store.snapshot()).learning).toMatchObject({ enabled: false, signals: 0, newSignals: 0 })
  })

  it('remembers projects with the brand off, per project', async () => {
    const store = new UserMemoryStore(file)
    await store.change({ action: 'project-brand', projectId: 'p1', enabled: false })
    expect(await store.projectUsesBrand('p1')).toBe(false)
    expect(await store.projectUsesBrand('p2')).toBe(true)
    expect((await store.snapshot('p1')).projectUsesBrand).toBe(false)
    await store.change({ action: 'project-brand', projectId: 'p1', enabled: true })
    expect(await store.projectUsesBrand('p1')).toBe(true)
  })

  it('adds up background model usage, unpriced once any call is', async () => {
    const store = new UserMemoryStore(file)
    await store.recordBackgroundUsage({ inputTokens: 100, outputTokens: 10, estimatedCostCny: 0.01 })
    await store.recordBackgroundUsage({ inputTokens: 50, outputTokens: 5, estimatedCostCny: 0.02 })
    expect((await store.read()).backgroundUsage).toMatchObject({ calls: 2, inputTokens: 150, outputTokens: 15, estimatedCostCny: expect.closeTo(0.03, 6) })
    await store.recordBackgroundUsage({ inputTokens: 1, outputTokens: 1, estimatedCostCny: null })
    expect((await store.read()).backgroundUsage.estimatedCostCny).toBeNull()
  })

  it('tells listeners after each change, and not for one that changes nothing', async () => {
    const store = new UserMemoryStore(file)
    let calls = 0
    store.onChange(() => { calls += 1 })
    await store.change({ action: 'add', kind: 'fact', content: '卖手冲咖啡' })
    await store.clearLogo()
    expect(calls).toBe(1)
  })
})

describe('signals by project', () => {
  it('forgets one project\'s signals and what they counted toward the next summary', async () => {
    const store = new UserMemoryStore(file)
    await store.recordSignal('said', '太花了', 'p1')
    await store.recordSignal('said', '要简洁', 'p2')
    await store.recordSignal('edited', '换了字体', 'p1')
    await store.dropProjectSignals('p1')
    const after = await store.read()
    expect(after.signals.map((signal) => signal.text)).toEqual(['要简洁'])
    expect(after.learning.newSignals).toBe(1)
  })
})
