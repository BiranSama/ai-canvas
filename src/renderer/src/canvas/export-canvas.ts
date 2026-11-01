import { withMaskViewSetAside } from './mask-state'
import type { CanvasStageHandle } from './CanvasStage'

export type ExportFormat = 'png' | 'jpeg' | 'webp'

function downloadDataUrl(dataUrl: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = filename
  anchor.click()
}

export function exportFilename(projectName: string, format: ExportFormat): string {
  const extension = format === 'jpeg' ? 'jpg' : format
  const safeName = projectName
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .split('')
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 96)
  return `${safeName || '未命名作品'}.${extension}`
}

/** The artwork at its output size, from whichever canvas is on screen: the editor's, or the live one beside the conversation. */
export function exportCanvasImage(stage: CanvasStageHandle | null, projectName: string, format: ExportFormat, jpegBackground: string): void {
  void withMaskViewSetAside(() => {
    const dataUrl = stage?.exportDataUrl(format, jpegBackground)
    if (dataUrl !== null && dataUrl !== undefined) downloadDataUrl(dataUrl, exportFilename(projectName, format))
  })
}
