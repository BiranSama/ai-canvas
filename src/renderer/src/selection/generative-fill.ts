import type { GrayMask } from '../../../shared/mask-raster'
import { showAppNotice } from '../components/app-notice'
import { preferredImageProvider } from '../generation/preferred-provider'
import { useWorkspaceStore } from '../store/workspace-store'

/*
 * Photoshop's Generative Fill and Generative Expand: the image service
 * repaints the picture inside a gray mask the canvas's size (the selection,
 * or what a larger canvas added); the result comes back as a new layer
 * masked by it, placed from the generation view.
 */

export async function submitGenerativeFill(mask: GrayMask, prompt: string, options: { readonly expand?: boolean } = {}): Promise<boolean> {
  const { scene, setActiveView } = useWorkspaceStore.getState()
  try {
    const asset = await window.desktop.importPixels({ projectId: scene.projectId, name: options.expand === true ? '生成式扩展区域.png' : '生成式填充选区.png', width: mask.width, height: mask.height, gray: new Uint8Array(mask.data) })
    const provider = await preferredImageProvider('edit')
    if (provider.note !== null) showAppNotice(provider.note)
    await window.desktop.editFromCanvas({
      scene: useWorkspaceStore.getState().scene,
      targetElementId: null,
      mode: 'selection',
      selectionMaskAssetId: asset.id,
      expand: options.expand === true,
      prompt: prompt.trim() || (options.expand === true ? '按周围画面自然延伸' : '按周围的画面自然补全选区'),
      negativePrompt: '',
      providerId: provider.providerId,
      model: provider.model,
      count: 1,
      profileId: provider.profileId,
      confirmed: provider.confirmed,
      sourceMessageId: null,
      parentResultId: null
    })
    setActiveView('generate')
    return true
  } catch (error) {
    showAppNotice(`${options.expand === true ? '生成式扩展' : '生成式填充'}没有开始：${error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)}`, 'problem')
    return false
  }
}

/** How wide the band is where the new picture fades into the old: 3% of the shorter side, at least 8 pixels. */
export function expandBand(width: number, height: number): number {
  return Math.max(8, Math.round(Math.min(width, height) * 0.03))
}

/**
 * The area a larger canvas added around the old picture (`old`, in the new
 * canvas's pixels), white, fading to black across a band inside the old
 * picture along each side that has new area beyond it, so the new picture
 * blends into the old with no seam. Null when nothing was added.
 */
export function expandMask(width: number, height: number, old: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }): GrayMask | null {
  const left = Math.max(0, old.left)
  const top = Math.max(0, old.top)
  const right = Math.min(width, old.left + old.width)
  const bottom = Math.min(height, old.top + old.height)
  const open = { left: old.left > 0, top: old.top > 0, right: old.left + old.width < width, bottom: old.top + old.height < height }
  if (!open.left && !open.top && !open.right && !open.bottom) return null
  const band = expandBand(width, height)
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < left || x >= right || y < top || y >= bottom) { data[y * width + x] = 255; continue }
      // Distance in from the nearest open side, pixel centres.
      let distance = Number.POSITIVE_INFINITY
      if (open.left) distance = Math.min(distance, x + 0.5 - left)
      if (open.top) distance = Math.min(distance, y + 0.5 - top)
      if (open.right) distance = Math.min(distance, right - x - 0.5)
      if (open.bottom) distance = Math.min(distance, bottom - y - 0.5)
      if (distance < band) data[y * width + x] = Math.round(255 * (1 - distance / band))
    }
  }
  return { width, height, data }
}
