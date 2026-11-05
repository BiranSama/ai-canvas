import { FolderOpen, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExportImageFormat } from '../../../shared/artwork-export'
import { pdfLayout, PRINT_WIDTHS, scaledSize, SIZE_PRESETS, validExportSize, type PdfPageChoice, type SizePreset } from '../../../shared/export-presets'
import { exportImage, exportPdf, exportPsd, exportSizes, sizePreview, softPrintImages, type ExportOutcome, type ExportProgress, type SoftImage } from '../export/export-artwork'
import { useModalScope } from '../interaction/use-modal-scope'
import { useWorkspaceStore } from '../store/workspace-store'

/*
 * 导出: the picture as an image, a layered PSD, a PDF to view or print, or
 * at several sizes at once. Each choice is remembered on this computer.
 */

type ExportKind = 'image' | 'psd' | 'pdf' | 'sizes'

interface Remembered {
  readonly kind: ExportKind
  readonly format: ExportImageFormat
  readonly scale: number
  readonly jpegBackground: string
  readonly editableText: boolean
  readonly page: 'screen' | 'print'
  readonly printWidthMm: number
  readonly sizes: readonly string[]
  readonly sizesFormat: 'png' | 'jpeg'
}

const STORAGE_KEY = 'ai-canvas.export-options'
const DEFAULTS: Remembered = { kind: 'image', format: 'png', scale: 1, jpegBackground: '#F5F4F1', editableText: true, page: 'screen', printWidthMm: 210, sizes: ['xiaohongshu', 'square'], sizesFormat: 'png' }

function remembered(): Remembered {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Remembered> | null
    return stored === null || typeof stored !== 'object' ? DEFAULTS : { ...DEFAULTS, ...stored }
  } catch {
    return DEFAULTS
  }
}

function remember(options: Remembered): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(options))
  } catch {
    // Without storage the panel starts from its defaults next time.
  }
}

const KINDS: readonly { readonly kind: ExportKind; readonly label: string; readonly detail: string }[] = [
  { kind: 'image', label: '图片', detail: 'PNG、JPEG、WebP' },
  { kind: 'psd', label: 'PSD', detail: '带图层，在 PS 里接着改' },
  { kind: 'pdf', label: 'PDF', detail: '发给客户或拿去打印' },
  { kind: 'sizes', label: '多尺寸', detail: '一次导出各平台的尺寸' }
]

type Run =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly progress: ExportProgress | null }
  | { readonly state: 'done'; readonly outcome: ExportOutcome }
  | { readonly state: 'failed'; readonly message: string }

function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? path : path.slice(0, cut)
}

export function ExportSheet({ onClose, onSaveSizeAsProject }: {
  readonly onClose: () => void
  /** Copies the project laid out at this size and opens the copy. */
  readonly onSaveSizeAsProject: (size: SizePreset) => void
}): React.JSX.Element {
  const scene = useWorkspaceStore((state) => state.scene)
  const projectName = useWorkspaceStore((state) => state.projectName)
  const modalRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [options, setOptions] = useState<Remembered>(remembered)
  const [custom, setCustom] = useState<readonly SizePreset[]>([])
  const [customWidth, setCustomWidth] = useState('')
  const [customHeight, setCustomHeight] = useState('')
  const [run, setRun] = useState<Run>({ state: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  const running = run.state === 'running'
  const close = (): void => {
    abortRef.current?.abort()
    onClose()
  }
  useModalScope(modalRef, close, { initialFocus: closeRef })

  const update = (change: Partial<Remembered>): void => {
    setOptions((current) => {
      const next = { ...current, ...change }
      remember(next)
      return next
    })
    if (run.state !== 'running') setRun({ state: 'idle' })
  }

  const width = scene.canvas.outputWidth
  const height = scene.canvas.outputHeight
  const page: PdfPageChoice = options.page === 'screen' ? { kind: 'screen' } : { kind: 'print', widthMm: options.printWidthMm }
  const layout = pdfLayout(scene.canvas, page)
  const allSizes = useMemo(() => [...SIZE_PRESETS, ...custom], [custom])
  const chosenSizes = allSizes.filter((size) => options.sizes.includes(size.id))

  const start = (): void => {
    if (running) return
    const controller = new AbortController()
    abortRef.current = controller
    setRun({ state: 'running', progress: null })
    const progress = (value: ExportProgress): void => setRun({ state: 'running', progress: value })
    const name = projectName
    const work = options.kind === 'image'
      ? exportImage(scene, name, { format: options.format, scale: options.scale, jpegBackground: options.jpegBackground }, controller.signal, progress)
      : options.kind === 'psd'
        ? exportPsd(scene, name, { editableText: options.editableText }, controller.signal, progress)
        : options.kind === 'pdf'
          ? exportPdf(scene, name, page, controller.signal, progress)
          : exportSizes(scene, name, chosenSizes, options.sizesFormat, controller.signal, progress)
    void work.then((outcome) => {
      if (abortRef.current !== controller) return
      setRun(outcome === null ? { state: 'idle' } : { state: 'done', outcome })
    }).catch((error: unknown) => {
      if (abortRef.current !== controller) return
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      setRun({ state: 'failed', message: aborted ? '已取消，没有保存文件。' : error instanceof Error ? error.message : '导出没有完成。' })
    })
  }

  const cancel = (): void => {
    abortRef.current?.abort()
    abortRef.current = null
    setRun({ state: 'failed', message: '已取消，没有保存文件。' })
  }

  const addCustom = (): void => {
    const w = Number(customWidth)
    const h = Number(customHeight)
    if (!validExportSize(w, h)) return
    const id = `custom-${w}x${h}`
    if (!allSizes.some((size) => size.id === id)) setCustom((current) => [...current, { id, label: '自定义', ratio: `${w}:${h}`, width: w, height: h }])
    update({ sizes: [...new Set([...options.sizes, id])] })
    setCustomWidth('')
    setCustomHeight('')
  }

  const customValid = validExportSize(Number(customWidth), Number(customHeight))
  const canExport = !running && (options.kind !== 'sizes' || chosenSizes.length > 0)

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !running) close() }}>
      <section ref={modalRef} tabIndex={-1} className="export-sheet" role="dialog" aria-label="导出" aria-modal="true">
        <header>
          <div>
            <h2>导出</h2>
            <p>{projectName} · {width}×{height}</p>
          </div>
          <button ref={closeRef} type="button" className="icon-button" aria-label="关闭导出" onClick={close}><X size={16} /></button>
        </header>
        <div className="export-body">
          <nav className="export-kinds" aria-label="导出什么">
            {KINDS.map((item) => (
              <button key={item.kind} type="button" aria-pressed={options.kind === item.kind} disabled={running} onClick={() => update({ kind: item.kind })}>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </button>
            ))}
          </nav>
          <div className="export-options">
            {options.kind === 'image' && (
              <ImageOptions options={options} transparent={scene.canvas.transparent} width={width} height={height} disabled={running} onChange={update} />
            )}
            {options.kind === 'psd' && (
              <section aria-label="PSD 选项">
                <label className="export-check">
                  <input type="checkbox" checked={options.editableText} disabled={running} onChange={(event) => update({ editableText: event.currentTarget.checked })} />
                  <span>文字保留为可编辑文字</span>
                </label>
                <ul className="export-notes">
                  <li>图层的顺序、名字、位置、不透明度、显示隐藏、混合模式、组和蒙版都带过去，在 PS 里能接着改。</li>
                  <li>{options.editableText ? '文字在 PS 里能改字；打开时先是画布上的样子，改字后由 PS 重新排版，换行可能略有不同。描边和阴影变成 PS 的图层样式。' : '文字按画布上的样子导出成像素，在 PS 里不能改字。'}</li>
                  <li>形状、图片效果和画过的笔触按画布上的样子导出成像素图层。</li>
                  {!scene.canvas.transparent && <li>画布底色是最底下的「背景色」图层。</li>}
                </ul>
              </section>
            )}
            {options.kind === 'pdf' && (
              <PdfOptions options={options} page={page} layoutText={`${Math.round(layout.widthMm)} × ${Math.round(layout.heightMm)} mm · ${layout.width}×${layout.height} 像素${layout.dpi === null ? '' : ` · ${layout.dpi} DPI`}`} disabled={running} onChange={update} />
            )}
            {options.kind === 'sizes' && (
              <section aria-label="多尺寸选项">
                <div className="export-size-grid" role="group" aria-label="尺寸">
                  {allSizes.map((size) => (
                    <SizeCard
                      key={size.id}
                      size={size}
                      checked={options.sizes.includes(size.id)}
                      disabled={running}
                      onToggle={(checked) => update({ sizes: checked ? [...new Set([...options.sizes, size.id])] : options.sizes.filter((id) => id !== size.id) })}
                      onSaveAsProject={() => { close(); onSaveSizeAsProject(size) }}
                    />
                  ))}
                </div>
                <div className="export-custom-size" role="group" aria-label="自定义尺寸">
                  <label><span>宽</span><input inputMode="numeric" aria-label="自定义宽度" value={customWidth} disabled={running} onChange={(event) => setCustomWidth(event.currentTarget.value.replace(/\D/g, ''))} /></label>
                  <span aria-hidden="true">×</span>
                  <label><span>高</span><input inputMode="numeric" aria-label="自定义高度" value={customHeight} disabled={running} onChange={(event) => setCustomHeight(event.currentTarget.value.replace(/\D/g, ''))} /></label>
                  <button type="button" className="settings-save" disabled={!customValid || running} onClick={addCustom}><Plus size={13} aria-hidden="true" />加上</button>
                  <small>每边 64–16384 像素。</small>
                </div>
                <div className="export-segmented" role="radiogroup" aria-label="多尺寸格式">
                  {(['png', 'jpeg'] as const).map((format) => (
                    <button key={format} type="button" role="radio" aria-checked={options.sizesFormat === format} disabled={running} onClick={() => update({ sizesFormat: format })}>{format === 'png' ? 'PNG' : 'JPEG'}</button>
                  ))}
                </div>
                <ul className="export-notes">
                  <li>在本机自动排版，不花钱：背景铺满，其余内容等比缩放，贴边的元素仍贴边，组在一起的一起移动。比例差得远的可能还要再调，点「另存为新项目」接着改。</li>
                  <li>每个尺寸一个文件，存到你选的文件夹；重名时加序号，不覆盖。原项目不变。</li>
                </ul>
              </section>
            )}
          </div>
        </div>
        <footer>
          <div className="export-status" role="status">
            {run.state === 'running' && <span>{run.progress === null ? '正在准备…' : `${run.progress.label}${run.progress.total > 1 ? `（${Math.min(run.progress.done, run.progress.total)}/${run.progress.total}）` : ''}`}</span>}
            {run.state === 'done' && (
              <span data-saved-path={run.outcome.paths[0]}>
                {run.outcome.paths.length === 1 ? `已保存到 ${run.outcome.paths[0]}` : `已保存 ${run.outcome.paths.length} 个文件到 ${folderOf(run.outcome.paths[0] ?? '')}`}
                {run.outcome.notes.map((note) => <small key={note}>{note}</small>)}
              </span>
            )}
            {run.state === 'failed' && <span className="is-problem">{run.message}</span>}
          </div>
          {run.state === 'done' && run.outcome.paths[0] !== undefined && (
            <button type="button" className="settings-secondary" onClick={() => void window.desktop.revealExport(run.outcome.paths[0]!)}><FolderOpen size={13} aria-hidden="true" />打开所在文件夹</button>
          )}
          {running
            ? <button type="button" className="settings-secondary" onClick={cancel}>取消</button>
            : <button type="button" className="settings-save" disabled={!canExport} onClick={start}>{options.kind === 'sizes' ? `导出 ${chosenSizes.length} 个尺寸` : '导出'}</button>}
        </footer>
      </section>
    </div>
  )
}

function ImageOptions({ options, transparent, width, height, disabled, onChange }: {
  readonly options: Remembered
  readonly transparent: boolean
  readonly width: number
  readonly height: number
  readonly disabled: boolean
  onChange(change: Partial<Remembered>): void
}): React.JSX.Element {
  return (
    <section aria-label="图片选项">
      <div className="export-segmented" role="radiogroup" aria-label="图片格式">
        {(['png', 'jpeg', 'webp'] as const).map((format) => (
          <button key={format} type="button" role="radio" aria-checked={options.format === format} disabled={disabled} onClick={() => onChange({ format })}>{format === 'png' ? 'PNG' : format === 'jpeg' ? 'JPEG' : 'WebP'}</button>
        ))}
      </div>
      <div className="export-segmented" role="radiogroup" aria-label="倍数">
        {[1, 2, 3].map((scale) => {
          const size = scaledSize(width, height, scale)
          return <button key={scale} type="button" role="radio" aria-checked={options.scale === scale} disabled={disabled} onClick={() => onChange({ scale })}>{scale}×<small>{size.width}×{size.height}</small></button>
        })}
      </div>
      {options.format === 'jpeg' && transparent && (
        <label className="export-color">
          <span>JPEG 没有透明，透明的地方填这个颜色</span>
          <input type="color" aria-label="JPEG 背景色" value={options.jpegBackground} disabled={disabled} onChange={(event) => onChange({ jpegBackground: event.currentTarget.value })} />
        </label>
      )}
      <ul className="export-notes">
        <li>放大导出时文字和形状按矢量重画，仍然清楚；图片最多用到原图本身的清晰度。</li>
        {options.format === 'png' && transparent && <li>PNG 保留透明背景。</li>}
      </ul>
    </section>
  )
}

function PdfOptions({ options, page, layoutText, disabled, onChange }: {
  readonly options: Remembered
  readonly page: PdfPageChoice
  readonly layoutText: string
  readonly disabled: boolean
  onChange(change: Partial<Remembered>): void
}): React.JSX.Element {
  const scene = useWorkspaceStore((state) => state.scene)
  const [soft, setSoft] = useState<readonly SoftImage[]>([])
  const [customMm, setCustomMm] = useState(() => PRINT_WIDTHS.some((width) => width.widthMm === options.printWidthMm) ? '' : String(options.printWidthMm))
  const pageKey = page.kind === 'print' ? page.widthMm : 0
  useEffect(() => {
    let current = true
    const choice: PdfPageChoice = pageKey === 0 ? { kind: 'screen' } : { kind: 'print', widthMm: pageKey }
    void softPrintImages(scene, choice).then((found) => { if (current) setSoft(found) }).catch(() => { if (current) setSoft([]) })
    return () => { current = false }
  }, [scene, pageKey])
  return (
    <section aria-label="PDF 选项">
      <div className="export-segmented" role="radiogroup" aria-label="页面">
        <button type="button" role="radio" aria-checked={options.page === 'screen'} disabled={disabled} onClick={() => onChange({ page: 'screen' })}>屏幕查看</button>
        <button type="button" role="radio" aria-checked={options.page === 'print'} disabled={disabled} onClick={() => onChange({ page: 'print' })}>打印</button>
      </div>
      {options.page === 'print' && (
        <div className="export-segmented" role="radiogroup" aria-label="打印宽度">
          {PRINT_WIDTHS.map((width) => (
            <button key={width.id} type="button" role="radio" aria-checked={options.printWidthMm === width.widthMm && customMm === ''} disabled={disabled} onClick={() => { setCustomMm(''); onChange({ printWidthMm: width.widthMm }) }}>{width.label}<small>宽 {width.widthMm}mm</small></button>
          ))}
          <label className="export-mm">
            <span>自定义宽</span>
            <input inputMode="numeric" aria-label="打印宽度（毫米）" value={customMm} disabled={disabled} onChange={(event) => {
              const value = event.currentTarget.value.replace(/\D/g, '').slice(0, 4)
              setCustomMm(value)
              const mm = Number(value)
              if (mm >= 20 && mm <= 5000) onChange({ printWidthMm: mm })
            }} />
            <span>mm</span>
          </label>
        </div>
      )}
      <p className="export-layout">{layoutText}</p>
      <ul className="export-notes">
        {options.page === 'screen' ? <li>页面大小按画布像素算，适合发给客户在屏幕上看。</li> : <li>高度按画布比例；按 300 DPI 渲染，图文店一般够用。</li>}
        <li>PDF 里是一整张高清图，文字不能在 PDF 里选中或修改；要改字，回到项目或导出 PSD。颜色是 RGB。</li>
        {soft.map((image) => <li key={image.name} className="is-warning">「{image.name}」在这个尺寸上约 {image.dpi} DPI，打印可能发虚。</li>)}
      </ul>
    </section>
  )
}

function SizeCard({ size, checked, disabled, onToggle, onSaveAsProject }: {
  readonly size: SizePreset
  readonly checked: boolean
  readonly disabled: boolean
  onToggle(checked: boolean): void
  onSaveAsProject(): void
}): React.JSX.Element {
  const scene = useWorkspaceStore((state) => state.scene)
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    // Drawn a moment later, so opening the panel is not held up by six previews.
    const timer = window.setTimeout(() => {
      void sizePreview(scene, size, 220, controller.signal).then((url) => { if (!controller.signal.aborted) setPreview(url) }).catch(() => undefined)
    }, 120)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [scene, size])
  return (
    <div className={`export-size-card${checked ? ' is-checked' : ''}`}>
      <label>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onToggle(event.currentTarget.checked)} />
        <span className="export-size-preview">
          {preview !== null && <img src={preview} alt={`${size.label}预览`} />}
        </span>
        <strong>{size.label}</strong>
        <small>{size.ratio} · {size.width}×{size.height}</small>
      </label>
      <button type="button" className="export-size-project" disabled={disabled} onClick={onSaveAsProject}>另存为新项目</button>
    </div>
  )
}
