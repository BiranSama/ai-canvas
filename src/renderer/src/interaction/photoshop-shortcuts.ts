import type { SceneCommand, SceneElement } from '../../../domain'
import { BLEND_MODES, elementSupportsBlendMode, resolveBlendMode } from '../../../shared/blend-mode'
import { createBlankLayer, mergeDown, mergeVisible, stampVisible } from '../canvas/layer-actions'
import { fillLayer } from '../canvas/paint-controller'
import { isPaintTool, useWorkspaceStore, type CanvasTool, type PaintTool } from '../store/workspace-store'

/*
 * The Photoshop shortcuts that act on layers, colours and tools. App's
 * keyboard handler calls this first, after its own scope checks, so the
 * same keys do what they do in Photoshop. SHORTCUT_SHEET lists every key
 * the canvas answers to, for the shortcut sheet (Ctrl+Alt+Shift+K).
 */

export interface ShortcutEntry {
  readonly keys: string
  readonly action: string
}

export interface ShortcutGroup {
  readonly title: string
  readonly entries: readonly ShortcutEntry[]
}

export const SHORTCUT_SHEET: readonly ShortcutGroup[] = [
  {
    title: '工具',
    entries: [
      { keys: 'V', action: '选择（移动）' },
      { keys: 'H', action: '抓手' },
      { keys: '空格（按住）', action: '临时抓手' },
      { keys: 'T', action: '文字' },
      { keys: 'U', action: '形状' },
      { keys: 'I', action: '吸管：单击取前景色，Alt+单击取背景色' },
      { keys: 'B', action: '画笔' },
      { keys: 'E', action: '橡皮擦' },
      { keys: 'G / Shift+G', action: '油漆桶或渐变 / 在两者间切换' },
      { keys: 'Ctrl+T', action: '自由变换' },
      { keys: 'F', action: '专注模式' }
    ]
  },
  {
    title: '绘画',
    entries: [
      { keys: '[ / ]', action: '笔刷变小 / 变大' },
      { keys: 'Shift+[ / Shift+]', action: '笔刷变软 / 变硬' },
      { keys: '1 … 9, 0', action: '用绘画工具时：工具不透明度' },
      { keys: 'Shift+1 … 0', action: '用画笔或橡皮擦时：流量' },
      { keys: '按住 Alt', action: '用绘画工具时临时吸管' },
      { keys: 'Shift+单击', action: '从上一笔的终点画直线' },
      { keys: '拖动时按住 Shift', action: '渐变锁定在 45° 方向' },
      { keys: '/', action: '锁定或解锁所选图层的透明像素' }
    ]
  },
  {
    title: '颜色',
    entries: [
      { keys: 'X', action: '交换前景色和背景色' },
      { keys: 'D', action: '默认前景色和背景色（黑 / 白）' },
      { keys: 'Alt+Backspace', action: '用前景色填充所选图层（图片图层整层填满）' },
      { keys: 'Ctrl+Backspace', action: '用背景色填充所选图层' }
    ]
  },
  {
    title: '图层',
    entries: [
      { keys: 'Ctrl+Shift+N', action: '新建空白图层' },
      { keys: 'Ctrl+J', action: '复制图层（原位，放在原图层上方）' },
      { keys: 'Ctrl+E', action: '向下合并；选中多层时合并所选，选中组时合并组' },
      { keys: 'Ctrl+Shift+E', action: '合并可见图层' },
      { keys: 'Ctrl+Alt+Shift+E', action: '盖印：可见图层合成到一个新图层' },
      { keys: 'Alt+拖动', action: '拖出一个副本' },
      { keys: 'Ctrl+G / Ctrl+Shift+G', action: '组合 / 取消组合' },
      { keys: 'Ctrl+] / Ctrl+[', action: '上移一层 / 下移一层' },
      { keys: 'Ctrl+Shift+] / Ctrl+Shift+[', action: '置于顶层 / 置于底层' },
      { keys: 'Ctrl+,', action: '隐藏或显示所选图层' },
      { keys: 'Ctrl+/', action: '锁定或解锁所选图层' },
      { keys: 'Ctrl+Alt+A', action: '选择所有图层' },
      { keys: 'Ctrl+D', action: '取消选择' },
      { keys: '1 … 9, 0', action: '不透明度 10% … 90%, 100%；快速连按两位数字设精确值' },
      { keys: 'Shift+加号 / Shift+减号', action: '切换到下一个 / 上一个混合模式' },
      { keys: 'Alt+Shift+N / M / S / O / F', action: '正常 / 正片叠底 / 滤色 / 叠加 / 柔光' },
      { keys: 'Alt+单击眼睛', action: '只显示这一层，再按一次恢复' },
      { keys: 'Delete', action: '删除所选图层' },
      { keys: '方向键 / Shift+方向键', action: '移动 1 / 10 像素' }
    ]
  },
  {
    title: '编辑与文件',
    entries: [
      { keys: 'Ctrl+Z / Ctrl+Shift+Z', action: '撤销 / 重做' },
      { keys: 'Ctrl+C / Ctrl+X / Ctrl+V', action: '拷贝 / 剪切 / 粘贴' },
      { keys: 'Ctrl+N', action: '新建空白项目' },
      { keys: 'Ctrl+O', action: '打开图片或 PSD，自动建成项目' },
      { keys: 'Ctrl+Shift+S', action: '项目另存为' },
      { keys: 'Ctrl+Alt+Shift+K', action: '快捷键一览' }
    ]
  },
  {
    title: '视图',
    entries: [
      { keys: 'Ctrl+0', action: '按屏幕大小缩放' },
      { keys: 'Ctrl+1', action: '100%' },
      { keys: 'Ctrl+加号 / Ctrl+减号', action: '放大 / 缩小' },
      { keys: 'Alt+滚轮 / Ctrl+滚轮', action: '缩放' },
      { keys: '拖动时按住 Ctrl', action: '暂时不吸附' }
    ]
  }
]

const BLEND_LETTERS: Readonly<Record<string, (typeof BLEND_MODES)[number]>> = {
  KeyN: 'normal',
  KeyM: 'multiply',
  KeyS: 'screen',
  KeyO: 'overlay',
  KeyF: 'soft-light'
}

/** Photoshop takes two digits typed quickly as one value, 4 then 5 is 45%. */
const DIGIT_PAIR_MS = 400
let lastDigit: { readonly digit: number; readonly at: number } | null = null

export interface PhotoshopShortcutContext {
  chooseTool(tool: CanvasTool): void
  toggleFocusMode(): void
}

function selectedElements(): SceneElement[] {
  const { scene, selectedIds } = useWorkspaceStore.getState()
  return selectedIds
    .map((id) => scene.elements.find((element) => element.id === id))
    .filter((element): element is SceneElement => element !== undefined)
}

function updateEach(elements: readonly SceneElement[], summary: string, changes: (element: SceneElement) => Record<string, unknown> | null): void {
  const commands: SceneCommand[] = elements.flatMap((element) => {
    const next = changes(element)
    return next === null ? [] : [{ kind: 'element.update' as const, elementId: element.id, changes: next }]
  })
  if (commands.length > 0) void useWorkspaceStore.getState().execute(summary, commands)
}

function setOpacity(digit: number, now: number): void {
  const elements = selectedElements().filter((element) => !element.locked)
  if (elements.length === 0) return
  const paired = lastDigit !== null && now - lastDigit.at <= DIGIT_PAIR_MS
  const percent = paired ? lastDigit!.digit * 10 + digit : digit === 0 ? 100 : digit * 10
  lastDigit = paired ? null : { digit, at: now }
  const opacity = Math.max(0, Math.min(100, percent)) / 100
  updateEach(elements, `不透明度 ${Math.round(opacity * 100)}%`, () => ({ opacity }))
}

function setBlend(next: (current: (typeof BLEND_MODES)[number]) => (typeof BLEND_MODES)[number]): void {
  const elements = selectedElements().filter((element) => !element.locked && elementSupportsBlendMode(element.type))
  updateEach(elements, '切换混合模式', (element) => {
    const current = resolveBlendMode(element) as (typeof BLEND_MODES)[number]
    const blendMode = next(BLEND_MODES.includes(current) ? current : 'normal')
    return blendMode === current ? null : { blendMode }
  })
}

function fill(color: string, which: '前景色' | '背景色'): void {
  const elements = selectedElements().filter((element) => !element.locked)
  updateEach(elements.filter((element) => element.type === 'shape' || element.type === 'text'), `用${which}填充`, (element) => (element as { fill?: string }).fill === color ? null : { fill: color })
  // An image layer is filled with paint, as Photoshop fills a pixel layer.
  for (const element of elements) if (element.type === 'image') void fillLayer(element, color, `用${which}填充`)
}

/** Brush sizes step as Photoshop's [ and ] do: by 1 up to 10, then 10, 25, 50 and 100 as they grow. */
function stepSize(size: number, up: boolean): number {
  const step = (value: number): number => value < 10 ? 1 : value < 100 ? 10 : value < 200 ? 25 : value < 300 ? 50 : 100
  return up ? Math.min(5000, size + step(size)) : Math.max(1, size - step(size - 1))
}

function adjustBrush(tool: 'brush' | 'eraser', key: '[' | ']', shift: boolean): void {
  const { paintSettings, setPaintSettings } = useWorkspaceStore.getState()
  const settings = paintSettings[tool]
  if (shift) setPaintSettings(tool, { hardness: Math.max(0, Math.min(1, Math.round((settings.hardness + (key === ']' ? 0.25 : -0.25)) * 100) / 100)) })
  else setPaintSettings(tool, { size: stepSize(settings.size, key === ']') })
}

/** With a painting tool, digits set the tool's opacity (or with Shift the brush's flow), two quick ones as one value. */
function setToolAmount(tool: PaintTool, digit: number, now: number, flow: boolean): void {
  const paired = lastDigit !== null && now - lastDigit.at <= DIGIT_PAIR_MS
  const percent = paired ? lastDigit!.digit * 10 + digit : digit === 0 ? 100 : digit * 10
  lastDigit = paired ? null : { digit, at: now }
  const value = Math.max(1, Math.min(100, percent)) / 100
  const { setPaintSettings } = useWorkspaceStore.getState()
  if (flow && (tool === 'brush' || tool === 'eraser')) setPaintSettings(tool, { flow: value })
  else if (!flow) setPaintSettings(tool, { opacity: value })
}

function toggleTransparencyLock(): void {
  const images = selectedElements().filter((element): element is Extract<SceneElement, { type: 'image' }> => element.type === 'image' && !element.locked)
  const lock = images.some((element) => element.transparencyLocked !== true)
  updateEach(images, lock ? '锁定透明像素' : '解锁透明像素', (element) => (element.type === 'image' && (element.transparencyLocked === true) === lock) ? null : { transparencyLocked: lock })
}

/**
 * Runs the Photoshop shortcut for this key, if there is one, and reports
 * whether it did. Keys handled elsewhere (undo, copy, zoom, Delete and the
 * rest) are left alone.
 */
export function handlePhotoshopShortcut(event: KeyboardEvent, context: PhotoshopShortcutContext): boolean {
  const command = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  const state = useWorkspaceStore.getState()
  const run = (action: () => void): true => {
    event.preventDefault()
    action()
    return true
  }

  if (event.key === 'Backspace' || event.key === 'Delete') {
    if (event.altKey && !command) return run(() => fill(state.foregroundColor, '前景色'))
    if (command && !event.altKey) return run(() => fill(state.backgroundColor, '背景色'))
    return false
  }

  if (command) {
    if (event.altKey && !event.shiftKey && key === 'a') return run(() => state.setSelection(state.scene.elements.filter((element) => element.groupId === null).map((element) => element.id)))
    if (event.shiftKey && !event.altKey && key === 'n') return run(() => { void createBlankLayer() })
    if (event.code === 'KeyE' && event.shiftKey) return event.altKey ? run(() => { void stampVisible() }) : run(() => { void mergeVisible() })
    if (event.altKey || event.shiftKey) return false
    if (key === 'd') return run(() => state.setSelection([]))
    if (event.code === 'KeyE') return run(() => { void mergeDown() })
    if (key === 't') return run(() => state.setActiveTool('select'))
    if (event.key === ',') {
      return run(() => {
        const elements = selectedElements()
        const show = elements.length > 0 && elements.every((element) => !element.visible)
        updateEach(elements.filter((element) => !element.locked), show ? '显示图层' : '隐藏图层', (element) => element.visible === show ? null : { visible: show })
      })
    }
    if (event.key === '/') {
      return run(() => {
        const elements = selectedElements()
        const lock = elements.some((element) => !element.locked)
        updateEach(elements, lock ? '锁定图层' : '解锁图层', (element) => element.locked === lock ? null : { locked: lock })
      })
    }
    return false
  }

  if (event.altKey && event.shiftKey) {
    const mode = BLEND_LETTERS[event.code]
    return mode === undefined ? false : run(() => setBlend(() => mode))
  }
  if (event.altKey) return false

  const paintTool = isPaintTool(state.activeTool) ? state.activeTool : null
  if (event.shiftKey && key === 'g') return run(() => context.chooseTool(state.activeTool === 'bucket' ? 'gradient' : state.activeTool === 'gradient' ? 'bucket' : state.toolMemory.fill))
  if ((event.code === 'BracketLeft' || event.code === 'BracketRight') && (paintTool === 'brush' || paintTool === 'eraser')) {
    return run(() => adjustBrush(paintTool, event.code === 'BracketLeft' ? '[' : ']', event.shiftKey))
  }
  if (/^(Digit|Numpad)[0-9]$/.test(event.code) && paintTool !== null) return run(() => setToolAmount(paintTool, Number(event.code.slice(-1)), event.timeStamp || Date.now(), event.shiftKey))
  if (event.shiftKey) {
    if (state.activeTool !== 'select') return false
    if (event.key === '+' || event.key === '=') return run(() => setBlend((current) => BLEND_MODES[(BLEND_MODES.indexOf(current) + 1) % BLEND_MODES.length]!))
    if (event.key === '_' || event.key === '-') return run(() => setBlend((current) => BLEND_MODES[(BLEND_MODES.indexOf(current) + BLEND_MODES.length - 1) % BLEND_MODES.length]!))
    return false
  }

  if (/^(Digit|Numpad)[0-9]$/.test(event.code) && state.activeTool === 'select') return run(() => setOpacity(Number(event.code.slice(-1)), event.timeStamp || Date.now()))
  if (key === 'v') return run(() => context.chooseTool('select'))
  if (key === 'h') return run(() => context.chooseTool('hand'))
  if (key === 't') return run(() => context.chooseTool('text'))
  if (key === 'b') return run(() => context.chooseTool('brush'))
  if (key === 'e') return run(() => context.chooseTool('eraser'))
  if (key === 'g') return run(() => context.chooseTool(state.activeTool === 'bucket' || state.activeTool === 'gradient' ? state.activeTool : state.toolMemory.fill))
  if (event.code === 'Slash') return run(toggleTransparencyLock)
  if (key === 'u') return run(() => context.chooseTool('shape'))
  if (key === 'i') return run(() => context.chooseTool('eyedropper'))
  if (key === 'x') return run(() => state.swapColors())
  if (key === 'd') return run(() => state.resetColors())
  if (key === 'f') return run(() => context.toggleFocusMode())
  return false
}
