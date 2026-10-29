import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openableFileArguments, queueOpenFiles, takeOpenFileRequests } from '../../src/main/open-file-requests'
import { createProjectFromImage, openFileAsProject } from '../../src/renderer/src/project/open-file-project'
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
    await expect(createProjectFromImage(new File([new Uint8Array([1])], 'notes.gif', { type: 'image/gif' }))).rejects.toThrow('PNG、JPEG、WebP')
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

describe('opening a PSD as a project', () => {
  afterEach(() => vi.clearAllMocks())

  function stubPsdDesktop() {
    const bootstrap = bootstrapFor()
    let assetCount = 0
    const png = new Uint8Array([137, 80, 78, 71])
    const desktop = {
      readPsd: vi.fn().mockResolvedValue({
        width: 400,
        height: 200,
        opaqueBackground: true,
        groups: [{ name: '标题组', visible: false }],
        layers: [
          { name: '背景', left: 0, top: 0, width: 400, height: 200, opacity: 1, visible: true, blendMode: 'normal', groupIndex: null, png, mask: null },
          { name: '阴影', left: 40, top: 20, width: 80, height: 40, opacity: 0.5, visible: false, blendMode: 'multiply', groupIndex: 0, png, mask: null },
          { name: '光', left: -40, top: 100, width: 100, height: 100, opacity: 0.8, visible: true, blendMode: 'soft-light', groupIndex: 0, png, mask: { png, enabled: false } }
        ],
        composite: png,
        approximations: ['1 个图层的图层样式（投影、描边等）没有带过来'],
        keptAsPictures: ['1 个文字图层按画好的样子保留成图片']
      }),
      createProject: vi.fn().mockResolvedValue({ cancelled: false, bootstrap }),
      importAsset: vi.fn().mockImplementation(async () => ({ id: `00000000-0000-4000-8000-00000000000${++assetCount}`, width: 1, height: 1, format: 'png', hasAlpha: true })),
      executeSceneCommands: vi.fn().mockResolvedValue({ ok: true, receipt: { state: { scene: bootstrap.scene, sequence: 1, canUndo: true, canRedo: false } } })
    }
    Object.defineProperty(window, 'desktop', { configurable: true, value: desktop })
    return desktop
  }

  it('adds every layer bottom first at its place, groups them, and keeps Photoshop\'s flattened image hidden on top', async () => {
    const desktop = stubPsdDesktop()
    const opened = await openFileAsProject(new File([new Uint8Array([56, 66, 80, 83])], '海报.psd', { type: '' }))
    expect(desktop.readPsd).toHaveBeenCalledTimes(1)
    expect(desktop.createProject).toHaveBeenCalledWith({ suggestedName: '海报' })
    const commands = desktop.executeSceneCommands.mock.calls[0]![0].batch.commands
    expect(commands[0]).toMatchObject({ kind: 'scene.set-canvas', canvas: { outputWidth: 400, outputHeight: 200, aspectWidth: 2, aspectHeight: 1, transparent: false } })
    const added = commands.filter((command: { kind: string }) => command.kind === 'element.add').map((command: { element: Record<string, unknown> }) => command.element)
    expect(added.map((element: { name: string }) => element.name)).toEqual(['背景', '阴影', '光', 'PSD 原样（对照用）'])
    expect(added[0]).toMatchObject({ semanticRole: 'background', transform: { x: 0, y: 0, width: 1, height: 1 } })
    expect(added[1]).toMatchObject({ opacity: 0.5, visible: false, blendMode: 'multiply', transform: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })
    expect(added[2]).toMatchObject({ blendMode: 'soft-light', transform: { x: -0.1, y: 0.5, width: 0.25, height: 0.5 } })
    // A layer mask comes along as the layer's mask, turned off when it was off in Photoshop.
    expect(added[2].mask).toEqual({ assetId: expect.any(String), enabled: false })
    expect(added[2].mask.assetId).not.toBe(added[2].assetId)
    expect(added[1].mask).toBeUndefined()
    expect(added[3]).toMatchObject({ visible: false, referencePolicy: 'exclude', transform: { x: 0, y: 0, width: 1, height: 1 } })
    const group = commands.find((command: { kind: string }) => command.kind === 'element.group')
    expect(group).toMatchObject({ elementIds: [added[1].id, added[2].id], group: { name: '标题组', visible: false, type: 'group' } })
    expect(opened?.notice).toContain('已打开“海报.psd”，3 个图层')
    expect(opened?.notice).toContain('图层样式')
    expect(opened?.notice).toContain('PSD 原样（对照用）')
  })

  it('passes on what Main could not read, without Electron\'s wrapping', async () => {
    const desktop = stubPsdDesktop()
    desktop.readPsd.mockRejectedValue(new Error("Error invoking remote method 'project:psd-read': Error: 只支持 RGB、灰度和 CMYK 模式的 PSD，请先在 Photoshop 里转成 RGB。"))
    await expect(openFileAsProject(new File([new Uint8Array([1])], 'lab.psd'))).rejects.toThrow(/^只支持 RGB/)
    expect(desktop.createProject).not.toHaveBeenCalled()
  })
})
