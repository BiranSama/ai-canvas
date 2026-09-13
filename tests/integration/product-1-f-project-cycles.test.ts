import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GenerationRuntime } from '../../src/main/generation/generation-runtime'
import { makeText } from '../fixtures/scene-fixtures'

const PROJECT_CYCLES = 20
const roots: string[] = []
const runtimes: GenerationRuntime[] = []

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close().catch(() => undefined)
  while (roots.length > 0) {
    const root = roots.pop()
    if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

describe('Product 1.0 Stage F project-cycle reliability', () => {
  it(`creates, switches, closes and reopens ${PROJECT_CYCLES} distinct project packages without Scene data loss`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-canvas-product-1-f-project-cycles-'))
    roots.push(root)
    const userData = join(root, 'user-data')
    const first = await GenerationRuntime.create(userData)
    runtimes.push(first)
    const expected: Array<{
      readonly projectId: string
      readonly name: string
      readonly titleId: string
      readonly content: string
      readonly aspectWidth: number
      readonly outputWidth: number
    }> = []

    for (let index = 1; index <= PROJECT_CYCLES; index += 1) {
      const name = `Stage F 作品 ${String(index).padStart(2, '0')}`
      const created = await first.createProjectInLibrary(name)
      const titleId = randomUUID()
      const content = `PROJECT CYCLE ${String(index).padStart(2, '0')}`
      const aspectWidth = index % 3 === 0 ? 1 : index % 2 === 0 ? 3 : 4
      const aspectHeight = index % 3 === 0 ? 1 : index % 2 === 0 ? 2 : 5
      const outputWidth = 1000 + index * 10
      const title = {
        ...makeText(),
        id: titleId,
        name: `持久标题 ${index}`,
        content,
        description: `Stage F 项目周期 ${index} 的唯一内容`
      }
      const mutation = await first.executeSceneCommands({
        expectedSceneRevision: created.scene.revision,
        batch: {
          id: randomUUID(),
          origin: 'user',
          summary: `建立 Stage F 项目周期 ${index}`,
          commands: [
            {
              kind: 'scene.set-canvas',
              canvas: {
                ...created.scene.canvas,
                aspectWidth,
                aspectHeight,
                outputWidth,
                outputHeight: Math.round(outputWidth * aspectHeight / aspectWidth),
                globalStyle: `Stage F 项目周期 ${index} 唯一风格`
              }
            },
            { kind: 'element.add', element: title }
          ]
        }
      })
      if (!mutation.ok) throw new Error(mutation.error.message)
      expected.push({ projectId: created.projectId, name, titleId, content, aspectWidth, outputWidth })
      await expect(stat(join(userData, 'projects', `${name}.aicanvas`, 'project.db'))).resolves.toMatchObject({ size: expect.any(Number) })
    }

    await first.close()
    runtimes.pop()

    const reopened = await GenerationRuntime.create(userData)
    runtimes.push(reopened)
    const recent = await reopened.listRecentProjects()
    expect(recent).toHaveLength(PROJECT_CYCLES)
    expect(new Set(recent.map((project) => project.id))).toEqual(new Set(expected.map((project) => project.projectId)))
    expect(recent.every((project) => project.status === 'ready')).toBe(true)

    for (const project of expected) {
      const restored = await reopened.openRecentProject(project.projectId)
      expect(restored).toMatchObject({
        projectId: project.projectId,
        projectName: project.name,
        canUndo: true,
        scene: {
          revision: 1,
          canvas: {
            aspectWidth: project.aspectWidth,
            outputWidth: project.outputWidth,
            globalStyle: expect.stringContaining('Stage F 项目周期')
          },
          elements: [expect.objectContaining({
            id: project.titleId,
            type: 'text',
            content: project.content,
            description: expect.stringContaining('唯一内容')
          })]
        }
      })
    }

    await reopened.close()
    runtimes.pop()

    const finalRestart = await GenerationRuntime.create(userData)
    runtimes.push(finalRestart)
    const finalRecent = await finalRestart.listRecentProjects()
    expect(finalRecent).toHaveLength(PROJECT_CYCLES)
    expect(finalRestart.getWorkspaceBootstrap()).toMatchObject({
      projectId: expected.at(-1)?.projectId,
      projectName: expected.at(-1)?.name,
      scene: { elements: [expect.objectContaining({ content: expected.at(-1)?.content })] }
    })
  }, 20_000)
})
