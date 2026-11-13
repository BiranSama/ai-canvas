import { create } from 'zustand'
import type { CanvasFrame } from '../../../domain'
import { useWorkspaceStore } from '../store/workspace-store'
import { reframeCanvas } from './reframe-actions'

/*
 * Photoshop's crop tool (C): a frame over the canvas, first the whole of it,
 * dragged smaller to crop or past the canvas to extend it; Enter or ✓ gives
 * the canvas that frame in one step, Esc or ✗ puts the frame back. What lies
 * outside is kept, off the canvas (删除裁剪的像素 off). What the frame adds
 * is the background colour, or filled by the image service (生成式扩展).
 */

export type CropRatio = 'free' | 'original' | '1:1' | '4:5' | '3:2' | '16:9'

export const CROP_RATIOS: readonly { readonly key: CropRatio; readonly label: string }[] = [
  { key: 'free', label: '不受约束' },
  { key: 'original', label: '原始比例' },
  { key: '1:1', label: '1:1' },
  { key: '4:5', label: '4:5' },
  { key: '3:2', label: '3:2' },
  { key: '16:9', label: '16:9' }
]

export type CropFill = 'background' | 'generative'

interface CropState {
  /** The frame, in the canvas's pixels; null when the tool is not in use. */
  readonly frame: CanvasFrame | null
  readonly ratio: CropRatio
  /** The ratio turned on its side. */
  readonly portrait: boolean
  readonly fill: CropFill
  readonly prompt: string
  readonly busy: boolean
  reset(): void
  setFrame(frame: CanvasFrame): void
  setRatio(ratio: CropRatio, portrait?: boolean): void
  setFill(fill: CropFill): void
  setPrompt(prompt: string): void
  commit(): Promise<boolean>
}

function wholeCanvas(): CanvasFrame {
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  return { left: 0, top: 0, width: outputWidth, height: outputHeight }
}

/** Width over height for a ratio, or null when the frame is free. */
export function cropAspect(ratio: CropRatio, portrait: boolean): number | null {
  if (ratio === 'free') return null
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  const [w, h] = ratio === 'original' ? [outputWidth, outputHeight] : ratio.split(':').map(Number) as [number, number]
  return portrait ? h / w : w / h
}

/** The largest frame of this aspect inside the given one, about its centre. */
function fitted(frame: CanvasFrame, aspect: number): CanvasFrame {
  const width = Math.min(frame.width, frame.height * aspect)
  const height = width / aspect
  return { left: frame.left + (frame.width - width) / 2, top: frame.top + (frame.height - height) / 2, width, height }
}

/** Whether the frame reaches past the canvas anywhere, so the canvas grows there. */
export function frameExtends(frame: CanvasFrame): boolean {
  const { outputWidth, outputHeight } = useWorkspaceStore.getState().scene.canvas
  return frame.left < -0.5 || frame.top < -0.5 || frame.left + frame.width > outputWidth + 0.5 || frame.top + frame.height > outputHeight + 0.5
}

export const useCrop = create<CropState>((set, get) => ({
  frame: null,
  ratio: 'free',
  portrait: false,
  fill: 'background',
  prompt: '',
  busy: false,
  reset: () => {
    const { ratio, portrait } = get()
    const aspect = cropAspect(ratio, portrait)
    set({ frame: aspect === null ? wholeCanvas() : fitted(wholeCanvas(), aspect) })
  },
  setFrame: (frame) => set({ frame }),
  setRatio: (ratio, portrait = get().portrait) => {
    const aspect = cropAspect(ratio, portrait)
    const frame = get().frame ?? wholeCanvas()
    set({ ratio, portrait, frame: aspect === null ? frame : fitted(frame, aspect) })
  },
  setFill: (fill) => set({ fill }),
  setPrompt: (prompt) => set({ prompt }),
  commit: async () => {
    const { frame, fill, prompt, busy } = get()
    if (frame === null || busy) return false
    const whole = wholeCanvas()
    const rounded = { left: Math.round(frame.left), top: Math.round(frame.top), width: Math.round(frame.width), height: Math.round(frame.height) }
    if (rounded.left === whole.left && rounded.top === whole.top && rounded.width === whole.width && rounded.height === whole.height) return true
    set({ busy: true })
    try {
      const expand = fill === 'generative' && frameExtends(frame)
      return await reframeCanvas(rounded, expand ? '裁剪并生成式扩展' : '裁剪', { expand: expand ? { prompt } : null })
    } finally {
      set({ busy: false })
      // The frame starts again over the canvas as it now is.
      if (useWorkspaceStore.getState().activeTool === 'crop') get().reset()
    }
  }
}))

// The tool picked shows the frame over the whole canvas; another tool, or a canvas of another size, starts it over.
useWorkspaceStore.subscribe((state, previous) => {
  const crop = useCrop.getState()
  if (state.activeTool !== previous.activeTool) {
    if (state.activeTool === 'crop') crop.reset()
    else if (crop.frame !== null) useCrop.setState({ frame: null })
    return
  }
  if (state.activeTool === 'crop' && !crop.busy && (state.scene.canvas.outputWidth !== previous.scene.canvas.outputWidth || state.scene.canvas.outputHeight !== previous.scene.canvas.outputHeight || state.scene.projectId !== previous.scene.projectId)) crop.reset()
})
