import { maskFrame, reframeScene, remapGrayMask, type CanvasFrame, type SceneCommand } from '../../../domain'
import type { GrayMask } from '../../../shared/mask-raster'
import { maskCoverage, paintClipIds } from '../../../shared/paint-ops'
import { showAppNotice } from '../components/app-notice'
import { expandMask, submitGenerativeFill } from '../selection/generative-fill'
import { deselect } from '../selection/selection-actions'
import { useWorkspaceStore } from '../store/workspace-store'
import { clipLookup, grayAssetPixels, rememberGrayAsset, subscribeAssetPixels } from './asset-pixels'

/*
 * Photoshop's crop and 画布大小 on the canvas: the picture gets a new frame
 * in one step (see reframeScene), adjustment layers' masks cut or grown to
 * it first, and the pixel selection dropped, since it was drawn in the old
 * frame. With 生成式扩展 what the frame added is then filled by the image
 * service, blending into the picture across a band.
 */

const WAIT_MS = 15_000

/** Waits for pixels being read (an asset's gray, a mask's clips), or gives up after a while. */
function whenRead<T>(read: () => T | null): Promise<T | null> {
  const first = read()
  if (first !== null) return Promise.resolve(first)
  return new Promise((resolve) => {
    let unsubscribe = (): void => {}
    const timer = window.setTimeout(() => { unsubscribe(); resolve(null) }, WAIT_MS)
    unsubscribe = subscribeAssetPixels(() => {
      const value = read()
      if (value === null) return
      window.clearTimeout(timer)
      unsubscribe()
      resolve(value)
    })
  })
}

export interface ReframeOptions {
  /** Fill what the frame adds with the image service, with this description (blank for what is around). */
  readonly expand?: { readonly prompt: string } | null
}

export async function reframeCanvas(frame: CanvasFrame, label: string, options: ReframeOptions = {}): Promise<boolean> {
  const { scene } = useWorkspaceStore.getState()
  const plan = reframeScene(scene, frame)
  const masks: SceneCommand[] = []
  for (const remap of plan.maskRemaps) {
    const element = scene.elements.find((candidate) => candidate.id === remap.elementId)
    if (element?.type !== 'adjustment' || element.mask === null || element.mask === undefined) continue
    const mask = element.mask
    const gray = await whenRead(() => grayAssetPixels(mask.assetId))
    const clips = gray === null ? null : await whenRead(() => clipLookup(paintClipIds(mask.paint), gray))
    if (gray === null || clips === null) {
      showAppNotice(`「${element.name}」的蒙版没读出来，画布没有改。`, 'problem')
      return false
    }
    // What was painted on the mask goes into its pixels, which then follow the frame.
    const coverage = maskCoverage(gray.data, gray.width, gray.height, mask.paint, clips)
    const width = plan.canvas.outputWidth
    const height = plan.canvas.outputHeight
    const pixels: GrayMask = { width, height, data: remapGrayMask(coverage, gray.width, gray.height, maskFrame(remap, gray.width, gray.height), width, height) }
    const asset = await window.desktop.importPixels({ projectId: scene.projectId, name: `${element.name}蒙版.png`, width, height, gray: new Uint8Array(pixels.data) })
    rememberGrayAsset(asset.id, pixels)
    masks.push({ kind: 'element.update', elementId: element.id, changes: { mask: { assetId: asset.id, enabled: mask.enabled } } })
  }
  const current = useWorkspaceStore.getState()
  if (current.scene.revision !== scene.revision) {
    showAppNotice('画布在这期间改动过，没有改尺寸，请再试一次。')
    return false
  }
  if (!await current.execute(label, [...plan.commands, ...masks])) return false
  deselect()
  const expand = options.expand ?? null
  if (expand !== null) {
    // The old picture in the new frame's pixels.
    const old = { left: -frame.left, top: -frame.top, width: scene.canvas.outputWidth, height: scene.canvas.outputHeight }
    const mask = expandMask(plan.canvas.outputWidth, plan.canvas.outputHeight, old)
    if (mask !== null) await submitGenerativeFill(mask, expand.prompt, { expand: true })
  }
  return true
}
