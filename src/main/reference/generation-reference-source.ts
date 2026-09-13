import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import sharp from 'sharp'
import type { Scene } from '../../domain'
import type { GenerationJob, ProviderCapabilities } from '../../shared/generation'
import type { GenerationReferencePreview, GenerationReferencePreviewInput } from '../../shared/generation-reference'
import type { ProjectWorkspace } from '../storage/project-workspace'
import { ProviderError } from '../generation/provider'
import { readVerifiedReferenceBytes } from '../generation/verified-reference-bytes'
import { CompositeReferenceRenderer, elementPresentation } from './composite-reference-renderer'

export async function resolveGenerationReference(input: GenerationReferencePreviewInput, options: {
  readonly workspace: ProjectWorkspace
  readonly scene: Scene
  readonly jobs: readonly GenerationJob[]
  readonly capabilities: ProviderCapabilities
  readonly configurationIdentity: unknown
  readonly thumbnails: boolean
}): Promise<GenerationReferencePreview> {
  const { workspace, scene, capabilities } = options
  const fail = (message: string): never => { throw new ProviderError('REFERENCE_REVIEW_REQUIRED', message, 'validating') }
  if (input.projectId !== workspace.metadata.id) fail('参考对象不属于当前项目，请重新选择。')
  const source = input.source
  if (source.kind === 'unresolved') fail('这份旧草稿没有记录参考对象，请先选择仅文字、当前画布或指定图片。')
  if (source.kind === 'canvas' && (scene.projectId !== input.projectId || scene.revision !== source.sceneRevision)) {
    fail('画布已修改，请刷新参考预览并核对新的版本。')
  }
  let assetIds: string[] = []
  if (source.kind === 'result') {
    const result = options.jobs.filter((job) => job.projectId === input.projectId).flatMap((job) => job.results)
      .find((candidate) => candidate.id === source.resultId && candidate.projectId === input.projectId && candidate.assetAvailable !== false)
    if (result === undefined) fail('参考结果已不可用或不属于当前项目，请重新选择。')
    assetIds = [result!.assetId]
  } else if (source.kind === 'images') assetIds = [...new Set(source.assetIds)]
  else if (source.kind === 'canvas') {
    assetIds = [...new Set(scene.elements.filter((element) => elementPresentation(element, 'reference') !== 'omit')
      .flatMap((element) => element.type === 'image' ? [element.assetId]
        : element.type === 'text' && element.renderStrategy !== 'standard' && element.resultAssetId !== null ? [element.resultAssetId] : []))]
  }
  const assets = await workspace.repository.listAssets()
  const root = await realpath(workspace.directory)
  const resolved = new Map<string, { bytes: Buffer; hash: string }>()
  for (const id of assetIds) {
    const asset = assets.find((candidate) => candidate.id === id && candidate.projectId === input.projectId && candidate.status === 'available')
    if (asset === undefined) fail('参考素材已删除、丢失或不属于当前项目，请重新选择。')
    try {
      const path = await realpath(workspace.assets.resolveOriginal(asset!))
      const local = relative(root, path)
      if (local === '..' || local.startsWith('..\\') || local.startsWith('../') || isAbsolute(local)) fail('参考素材不在当前项目内。')
      const info = await stat(path)
      if (!info.isFile() || info.size <= 0 || info.size > 100 * 1024 * 1024) fail('参考文件大小已变化，请重新导入并核对。')
      const bytes = await readVerifiedReferenceBytes(path, asset!.contentHash)
      resolved.set(id, { bytes, hash: asset!.contentHash })
    } catch (error) {
      if (error instanceof ProviderError) throw error
      fail('参考素材无法读取，请重新导入并核对。')
    }
  }
  const modes: GenerationReferencePreview['supportedModes'] = source.kind === 'text' ? []
    : source.kind === 'canvas' ? capabilities.imageReferences ? ['structure', 'visual', 'hybrid'] : ['structure']
      : capabilities.imageReferences && (assetIds.length <= 1 || capabilities.multipleReferences) ? ['visual'] : []
  // Return available choices even when the currently selected mode is invalid;
  // submission checks this list and never silently downgrades the reference.
  const summary = source.kind === 'text' ? '仅使用文字要求，不附带画布或图片'
    : source.kind === 'canvas' ? `当前画布 · 版本 ${scene.revision} · ${scene.elements.filter((element) => element.visible && element.referencePolicy !== 'exclude').length} 个参考元素 · ${scene.relations.length} 条关系`
      : source.kind === 'result' ? '指定的本项目结果 · 仅提供观感参考，不包含可编辑结构'
        : `${assetIds.length} 张指定图片 · 仅提供观感参考，不包含可编辑结构`
  const signature = createHash('sha256').update(JSON.stringify({ version: 1, input, scene: source.kind === 'canvas' ? scene : null,
    assets: [...resolved].map(([id, value]) => ({ id, hash: value.hash })), configuration: options.configurationIdentity })).digest('hex')
  const thumbnails: string[] = []
  if (options.thumbnails && source.kind !== 'text') {
    const buffers = source.kind === 'canvas'
      ? [(await new CompositeReferenceRenderer(async (id) => resolved.get(id)?.bytes ?? null).render(scene, 'reference')).buffer]
      : [...resolved.values()].map((entry) => entry.bytes)
    for (const buffer of buffers) thumbnails.push(`data:image/webp;base64,${(await sharp(buffer).resize({ width: 360, height: 240, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()).toString('base64')}`)
  }
  return { source, signature, summary, supportedModes: modes, thumbnails, assetIds }
}
