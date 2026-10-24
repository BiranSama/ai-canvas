import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openableFileArguments, queueOpenFiles, takeOpenFileRequests } from '../../src/main/open-file-requests'
import { createProjectFromImage } from '../../src/renderer/src/project/open-image-project'
import { createNightVeilScene } from '../../src/renderer/src/fixtures/night-veil'

function bootstrapFor() {
  const scene = { ...createNightVeilScene(), elements: [] }
  return { projectId: scene.projectId, projectName: '海报', scene, sceneSequence: 0, canUndo: false, canRedo: false }
}

function stubDesktop(asset: { width: number; height: number; hasAlpha: boolean }) {
  const bootstrap = bootstrapFor()
  const executeSceneCommands = vi.fn().mockImplementation(async (input: { batch: { commands: unknown[] } }) => ({
    ok: true,
    receipt: { state: { scene: { ...bootstrap.scene, revision: 1 }, sequence: 1, canUndo: true, canRedo: false } },
    input
  }))
  const desktop = {
    createProject: vi.fn().mockResolvedValue({ cancelled: false, bootstrap }),
    importAsset: vi.fn().mockResolvedValue({ id: 'asset-1', format: 'png', ...asset }),
    executeSceneCommands
  }
  Object.defineProperty(window, 'desktop', { configurable: true, value: desktop })
  return desktop
}

describe('opening an image as a project', () => {
  afterEach(() => vi.clearAllMocks())

  it('names the project after the file and sizes the canvas to the image, with the image as 背景', async () => {
    const desktop = stubDesktop({ width: 3000, height: 2000, hasAlpha: false })
    const result = await createProjectFromImage(new File([new Uint8Array([1, 2, 3])], '海报.jpg', { type: 'image/jpeg' }))
    expect(result?.sceneSequence).toBe(1)
    expect(desktop.createProject).toHaveBeenCalledWith({ suggestedName: '海报' })
    const [canvasCommand, addCommand] = desktop.executeSceneCommands.mock.calls[0]![0].batch.commands
    expect(canvasCommand).toMatchObject({ kind: 'scene.set-canvas', canvas: { aspectWidth: 3, aspectHeight: 2, outputWidth: 3000, outputHeight: 2000, transparent: false } })
    expect(addCommand).toMatchObject({ kind: 'element.add', element: { type: 'image', assetId: 'asset-1', name: '背景', semanticRole: 'background', fit: 'cover', transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 } } })
  })

  it('keeps transparency as 图层 0 on a transparent canvas, and fits huge or tiny images into what a canvas allows', async () => {
    const desktop = stubDesktop({ width: 40_000, height: 20_000, hasAlpha: true })
    await createProjectFromImage(new File([new Uint8Array([1])], 'logo.png', { type: 'image/png' }))
    const [canvasCommand, addCommand] = desktop.executeSceneCommands.mock.calls[0]![0].batch.commands
    expect(canvasCommand).toMatchObject({ canvas: { outputWidth: 16_384, outputHeight: 8_192, aspectWidth: 2, aspectHeight: 1, transparent: true } })
    expect(addCommand.element.name).toBe('图层 0')
    expect(addCommand.element.semanticRole).not.toBe('background')

    stubDesktop({ width: 20, height: 10, hasAlpha: false })
    const tiny = (window.desktop as unknown as ReturnType<typeof stubDesktop>)
    await createProjectFromImage(new File([new Uint8Array([1])], 'icon.webp', { type: 'image/webp' }))
    expect(tiny.executeSceneCommands.mock.calls[0]![0].batch.commands[0].canvas).toMatchObject({ outputWidth: 128, outputHeight: 64 })
  })

  it('refuses what it cannot open before creating anything', async () => {
    const desktop = stubDesktop({ width: 10, height: 10, hasAlpha: false })
    await expect(createProjectFromImage(new File([new Uint8Array([1])], 'notes.gif', { type: 'image/gif' }))).rejects.toThrow('PNG、JPEG 或 WebP')
    expect(desktop.createProject).not.toHaveBeenCalled()
  })
})

describe('images the system asks to open', () => {
  let directory = ''
  afterEach(async () => { if (directory !== '') await rm(directory, { recursive: true, force: true }) })

  it('keeps image arguments, made absolute, and skips flags and the app path', () => {
    const cwd = resolve('/home/me')
    expect(openableFileArguments(['.', '--user-data-dir=/tmp/x', 'shots/a.PNG', '/abs/b.jpeg', 'c.txt', 'd.webp'], cwd)).toEqual([
      resolve(cwd, 'shots/a.PNG'),
      resolve(cwd, '/abs/b.jpeg'),
      resolve(cwd, 'd.webp')
    ])
  })

  it('hands each queued image over once, and drops ones that are gone', async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-files-'))
    const image = join(directory, '封面.png')
    await writeFile(image, new Uint8Array([137, 80, 78, 71]))
    expect(queueOpenFiles([image, join(directory, 'missing.jpg')])).toBe(true)
    expect(queueOpenFiles([image])).toBe(false)
    const requests = await takeOpenFileRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ name: '封面.png', mimeType: 'image/png' })
    expect([...requests[0]!.bytes]).toEqual([137, 80, 78, 71])
    expect(await takeOpenFileRequests()).toEqual([])
  })
})
