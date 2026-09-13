import sharp from 'sharp'
import { sceneSchema, type Scene, type SceneElement } from '../../domain'

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function colorFor(element: SceneElement): string {
  if (element.semanticRole === 'background') return '#66788c'
  if (element.type === 'text') return '#d58f76'
  if (element.type === 'light') return '#e0bd73'
  if (element.type === 'placeholder') return '#76a5d4'
  if (element.type === 'sketch') return '#879a76'
  if (element.type === 'mask') return element.mode === 'protect' ? '#79a7d8' : element.mode === 'generate' ? '#6faf8c' : '#c88c87'
  return '#9b82b0'
}

export class SemanticSheetRenderer {
  #svg(scene: Scene, transparentCanvas: boolean): { readonly buffer: Buffer; readonly width: number } {
    const width = scene.canvas.outputWidth
    const height = scene.canvas.outputHeight
    const panelWidth = Math.max(220, Math.round(width * .26))
    const outputWidth = width + panelWidth
    const visible = scene.elements.filter((element) => element.visible && element.type !== 'group')
    const outlines = visible.map((element, index) => {
      const x = element.transform.x * width
      const y = element.transform.y * height
      const w = element.transform.width * width
      const h = element.transform.height * height
      const color = colorFor(element)
      const label = `${index + 1}`
      const shape = element.type === 'mask'
        ? element.paths.map((path) => `<polygon points="${path.points.map((point) => `${point.x * width},${point.y * height}`).join(' ')}" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="3"/>`).join('')
        : element.type === 'placeholder' && element.frameShape === 'ellipse'
        ? `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${color}" fill-opacity=".1" stroke="${color}" stroke-width="3"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.max(4, Math.min(w, h) * .04)}" fill="${color}" fill-opacity=".1" stroke="${color}" stroke-width="3"/>`
      return `<g transform="rotate(${element.transform.rotation} ${x + w / 2} ${y + h / 2})">${shape}<circle cx="${x + 16}" cy="${y + 16}" r="14" fill="${color}"/><text x="${x + 16}" y="${y + 21}" text-anchor="middle" fill="#fff" font-family="Segoe UI,Microsoft YaHei UI,sans-serif" font-size="16" font-weight="700">${label}</text></g>`
    }).join('')
    const rows = visible.map((element, index) => {
      const y = 42 + index * 58
      const color = colorFor(element)
      const detail = `${element.semanticRole} · layer ${element.zIndex}`
      return `<g><circle cx="${width + 24}" cy="${y - 4}" r="10" fill="${color}"/><text x="${width + 24}" y="${y + 1}" text-anchor="middle" fill="#fff" font-family="Segoe UI,sans-serif" font-size="11" font-weight="700">${index + 1}</text><text x="${width + 44}" y="${y - 5}" fill="#e8edf2" font-family="Segoe UI,Microsoft YaHei UI,sans-serif" font-size="14" font-weight="600">${escapeXml(element.name)}</text><text x="${width + 44}" y="${y + 14}" fill="#9eabb8" font-family="Segoe UI,Microsoft YaHei UI,sans-serif" font-size="10">${escapeXml(detail)}</text></g>`
    }).join('')
    const svg = `<svg width="${outputWidth}" height="${height}" viewBox="0 0 ${outputWidth} ${height}" xmlns="http://www.w3.org/2000/svg">${transparentCanvas ? '' : `<rect width="${width}" height="${height}" fill="#11171e"/>`}<rect x="${width}" width="${panelWidth}" height="${height}" fill="#202832"/>${outlines}${rows}</svg>`
    return { buffer: Buffer.from(svg), width: outputWidth }
  }

  async render(sceneInput: Scene): Promise<Buffer> {
    const scene = sceneSchema.parse(sceneInput)
    return sharp(this.#svg(scene, false).buffer).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer()
  }

  async renderCombined(sceneInput: Scene, appearanceComposite: Buffer): Promise<Buffer> {
    const scene = sceneSchema.parse(sceneInput)
    const overlay = this.#svg(scene, true)
    const panelWidth = overlay.width - scene.canvas.outputWidth
    return sharp(appearanceComposite)
      .extend({ right: panelWidth, background: '#202832' })
      .composite([{ input: overlay.buffer }])
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer()
  }
}
