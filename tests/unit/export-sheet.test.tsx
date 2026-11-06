import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ExportSheet } from '../../src/renderer/src/components/ExportSheet'
import { createMerchantExampleScene } from '../../src/renderer/src/fixtures/merchant-examples'
import { useWorkspaceStore } from '../../src/renderer/src/store/workspace-store'
import { SIZE_PRESETS } from '../../src/shared/export-presets'

const exports = vi.hoisted(() => ({
  exportImage: vi.fn(),
  exportPsd: vi.fn(),
  exportPdf: vi.fn(),
  exportSizes: vi.fn(),
  sizePreview: vi.fn(async () => 'data:image/png;base64,AAAA'),
  softPrintImages: vi.fn(async () => [] as { name: string; dpi: number }[])
}))
vi.mock('../../src/renderer/src/export/export-artwork', () => exports)

const revealExport = vi.fn(async () => undefined)

beforeEach(() => {
  localStorage.clear()
  for (const mock of Object.values(exports)) mock.mockClear()
  exports.softPrintImages.mockResolvedValue([])
  revealExport.mockClear()
  Object.defineProperty(window, 'desktop', { configurable: true, value: { revealExport } })
  useWorkspaceStore.setState({ scene: createMerchantExampleScene('coffee-poster'), projectName: '咖啡店海报' })
})

function sheet(onSaveSizeAsProject = vi.fn(), onClose = vi.fn()) {
  render(<ExportSheet onClose={onClose} onSaveSizeAsProject={onSaveSizeAsProject} />)
  return { dialog: screen.getByRole('dialog', { name: '导出' }), onSaveSizeAsProject, onClose }
}

it('exports an image at the chosen format and scale, then offers its folder', async () => {
  exports.exportImage.mockResolvedValue({ paths: ['/out/咖啡店海报.jpg'], notes: [] })
  const { dialog } = sheet()
  expect(within(dialog).getByText('咖啡店海报 · 1024×1280')).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('radio', { name: 'JPEG' }))
  fireEvent.click(within(dialog).getByRole('radio', { name: /^2×/ }))
  expect(within(dialog).getByRole('radio', { name: /^2×/ })).toHaveTextContent('2048×2560')
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '导出' })) })
  expect(exports.exportImage).toHaveBeenCalledWith(expect.objectContaining({ canvas: expect.objectContaining({ outputWidth: 1024 }) }), '咖啡店海报', { format: 'jpeg', scale: 2, jpegBackground: '#F5F4F1' }, expect.any(AbortSignal), expect.any(Function))
  expect(within(dialog).getByRole('status')).toHaveTextContent('已保存到 /out/咖啡店海报.jpg')
  fireEvent.click(within(dialog).getByRole('button', { name: '打开所在文件夹' }))
  expect(revealExport).toHaveBeenCalledWith('/out/咖啡店海报.jpg')
})

it('remembers what was chosen for next time', () => {
  const first = sheet()
  fireEvent.click(within(first.dialog).getByRole('button', { name: /^PSD/ }))
  fireEvent.click(within(first.dialog).getByLabelText('文字保留为可编辑文字'))
  first.dialog.remove()
  const second = render(<ExportSheet onClose={vi.fn()} onSaveSizeAsProject={vi.fn()} />)
  const dialog = within(second.container).getByRole('dialog', { name: '导出' })
  expect(within(dialog).getByRole('button', { name: /^PSD/ })).toHaveAttribute('aria-pressed', 'true')
  expect(within(dialog).getByLabelText('文字保留为可编辑文字')).not.toBeChecked()
})

it('exports a PSD with text kept editable or as pixels', async () => {
  exports.exportPsd.mockResolvedValue({ paths: ['/out/咖啡店海报.psd'], notes: ['「主图」带羽化或阴影，蒙版并进了像素。'] })
  const { dialog } = sheet()
  fireEvent.click(within(dialog).getByRole('button', { name: /^PSD/ }))
  expect(within(dialog).getByLabelText('文字保留为可编辑文字')).toBeChecked()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '导出' })) })
  expect(exports.exportPsd).toHaveBeenCalledWith(expect.anything(), '咖啡店海报', { editableText: true }, expect.any(AbortSignal), expect.any(Function))
  expect(within(dialog).getByRole('status')).toHaveTextContent('蒙版并进了像素')
})

it('lays out a print PDF at 300 DPI and names images that would print soft', async () => {
  exports.softPrintImages.mockResolvedValue([{ name: '主体图', dpi: 120 }])
  exports.exportPdf.mockResolvedValue({ paths: ['/out/咖啡店海报.pdf'], notes: [] })
  const { dialog } = sheet()
  fireEvent.click(within(dialog).getByRole('button', { name: /^PDF/ }))
  expect(within(dialog).getByText(/1024×1280 像素/)).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('radio', { name: '打印' }))
  expect(within(dialog).getByRole('radio', { name: /^A4/ })).toHaveAttribute('aria-checked', 'true')
  expect(within(dialog).getByText('210 × 263 mm · 2480×3100 像素 · 300 DPI')).toBeInTheDocument()
  expect(await within(dialog).findByText('「主体图」在这个尺寸上约 120 DPI，打印可能发虚。')).toBeInTheDocument()
  fireEvent.change(within(dialog).getByLabelText('打印宽度（毫米）'), { target: { value: '100' } })
  expect(within(dialog).getByText(/^100 × 125 mm/)).toBeInTheDocument()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '导出' })) })
  expect(exports.exportPdf).toHaveBeenCalledWith(expect.anything(), '咖啡店海报', { kind: 'print', widthMm: 100 }, expect.any(AbortSignal), expect.any(Function))
})

it('exports the chosen sizes, adds a custom one and opens one as a new project', async () => {
  exports.exportSizes.mockResolvedValue({ paths: ['/out/a.png', '/out/b.png', '/out/c.png'], notes: [] })
  const { dialog, onSaveSizeAsProject, onClose } = sheet()
  fireEvent.click(within(dialog).getByRole('button', { name: /^多尺寸/ }))
  // 小红书 and the square post are chosen to begin with.
  expect(within(dialog).getByRole('button', { name: '导出 2 个尺寸' })).toBeEnabled()
  const add = within(dialog).getByRole('button', { name: '加上' })
  fireEvent.change(within(dialog).getByLabelText('自定义宽度'), { target: { value: '63' } })
  fireEvent.change(within(dialog).getByLabelText('自定义高度'), { target: { value: '400' } })
  expect(add).toBeDisabled()
  fireEvent.change(within(dialog).getByLabelText('自定义宽度'), { target: { value: '1200' } })
  fireEvent.change(within(dialog).getByLabelText('自定义高度'), { target: { value: '628' } })
  fireEvent.click(add)
  expect(within(dialog).getByRole('checkbox', { name: /1200×628/ })).toBeChecked()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '导出 3 个尺寸' })) })
  const sizes = exports.exportSizes.mock.calls[0]![2] as { id: string }[]
  expect(sizes.map((size) => size.id)).toEqual(['xiaohongshu', 'square', 'custom-1200x628'])
  expect(within(dialog).getByRole('status')).toHaveTextContent('已保存 3 个文件到 /out')
  await waitFor(() => expect(exports.sizePreview).toHaveBeenCalled())

  const banner = SIZE_PRESETS.find((size) => size.id === 'banner')!
  const card = within(dialog).getByRole('checkbox', { name: /横幅/ }).closest('.export-size-card') as HTMLElement
  fireEvent.click(within(card).getByRole('button', { name: '另存为新项目' }))
  expect(onClose).toHaveBeenCalled()
  expect(onSaveSizeAsProject).toHaveBeenCalledWith(banner)
})

it('stops an export that is under way', async () => {
  exports.exportImage.mockImplementation((_scene: unknown, _name: string, _options: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('导出已取消。', 'AbortError')))
  }))
  const { dialog } = sheet()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '导出' })) })
  expect(within(dialog).getByRole('status')).toHaveTextContent('正在准备')
  expect(within(dialog).getByRole('button', { name: /^PSD/ })).toBeDisabled()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '取消' })) })
  expect(within(dialog).getByRole('status')).toHaveTextContent('已取消，没有保存文件。')
  expect(within(dialog).getByRole('button', { name: '导出' })).toBeEnabled()
})
