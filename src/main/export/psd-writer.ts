import { writePsdUint8Array, type Color, type Justification, type Layer, type LayerEffectsInfo, type LayerTextData, type Psd } from 'ag-psd'
import type { PsdAdjustment, PsdDocument, PsdLayer, PsdNode, PsdText } from '../../shared/artwork-export'
import { toPsdAdjustment } from '../psd/psd-adjustments'
import { PSD_BLEND_MODES } from '../psd/psd-blend'

/*
 * Writes the layers the page drew into a PSD Photoshop opens as layers:
 * names, order, visibility, opacity, blend modes, nested groups and layer
 * masks as Photoshop has them. Text stays editable: the layer keeps the
 * canvas's pixels for its look and carries the words, font and layout for
 * Photoshop to set again once someone edits it; its stroke and shadow become
 * layer styles, so the pixels hold the letters alone.
 */

/** The installed face for a family at a weight, as Photoshop names fonts. */
export interface PsdFont {
  readonly postScriptName: string
  /** Photoshop draws it bold itself: the family has no face that heavy. */
  readonly fauxBold: boolean
}
export type PsdFontLookup = (family: string, weight: number) => Promise<PsdFont>

const JUSTIFICATION: Readonly<Record<PsdText['align'], Justification>> = { start: 'left', center: 'center', end: 'right', justify: 'justify-left' }

function color(hex: string): Color {
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) }
}

function pixelData(width: number, height: number, data: Uint8Array): { width: number; height: number; data: Uint8ClampedArray } {
  return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) }
}

/** A gray mask as the RGBA Photoshop's writer reads its first channel from. */
function maskData(width: number, height: number, gray: Uint8Array): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < gray.length; index += 1) {
    const value = gray[index]!
    data[index * 4] = value
    data[index * 4 + 1] = value
    data[index * 4 + 2] = value
    data[index * 4 + 3] = 255
  }
  return { width, height, data }
}

/**
 * The words as Photoshop sets them: a text box at the canvas's box, turned
 * about its top-left corner, with the lines starting where the canvas
 * centres them. Vertical text is drawn as one character a line, so it goes
 * across the same way.
 */
async function textData(text: PsdText, fonts: PsdFontLookup): Promise<{ readonly text: LayerTextData; readonly effects: LayerEffectsInfo | undefined }> {
  const font = await fonts(text.fontFamily, text.fontWeight)
  const angle = text.rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const top = Math.max(0, (text.box.height - text.textHeight) / 2)
  const content = (text.orientation === 'vertical' ? [...text.content.replace(/\r?\n/g, '')].join('\r') : text.content.replace(/\r?\n/g, '\r'))
  const data: LayerTextData = {
    text: content,
    transform: [cos, sin, -sin, cos, text.box.x, text.box.y],
    antiAlias: 'smooth',
    orientation: 'horizontal',
    shapeType: 'box',
    // Room below the last line, so a font that sets a little taller is not cut off by the box.
    boxBounds: [0, top, text.box.width, top + text.textHeight + text.fontSize],
    style: {
      font: { name: font.postScriptName },
      fontSize: text.fontSize,
      fauxBold: font.fauxBold,
      autoLeading: false,
      leading: text.fontSize * text.lineHeight,
      tracking: Math.round(text.letterSpacing / text.fontSize * 1000),
      autoKerning: true,
      // A translucent fill stays translucent in the letters themselves, apart from the layer's opacity.
      fillColor: { ...color(text.color), a: Math.round(text.fillOpacity * 255) }
    },
    paragraphStyle: { justification: JUSTIFICATION[text.align] }
  }
  const effects: LayerEffectsInfo = {}
  if (text.stroke !== null) {
    effects.stroke = [{
      present: true, showInDialog: true, enabled: true,
      size: { units: 'Pixels', value: text.stroke.width }, position: 'center', fillType: 'color',
      blendMode: 'normal', opacity: text.stroke.opacity, color: color(text.stroke.color)
    }]
  }
  if (text.shadow !== null) {
    effects.dropShadow = [{
      present: true, showInDialog: true, enabled: true,
      size: { units: 'Pixels', value: text.shadow.blur }, distance: { units: 'Pixels', value: 0 }, angle: 90,
      useGlobalLight: false, color: color(text.shadow.color), blendMode: 'normal', opacity: text.shadow.opacity
    }]
  }
  return { text: data, effects: effects.stroke === undefined && effects.dropShadow === undefined ? undefined : effects }
}

async function layerOf(layer: PsdLayer, fonts: PsdFontLookup): Promise<Layer> {
  const result: Layer = {
    name: layer.name,
    hidden: layer.hidden,
    opacity: layer.opacity,
    blendMode: PSD_BLEND_MODES[layer.blendMode],
    left: layer.left,
    top: layer.top,
    right: layer.left + layer.width,
    bottom: layer.top + layer.height
  }
  if (layer.width > 0 && layer.height > 0) result.imageData = pixelData(layer.width, layer.height, layer.pixels)
  if (layer.mask !== null && layer.mask.width > 0 && layer.mask.height > 0) {
    result.mask = {
      left: layer.mask.left,
      top: layer.mask.top,
      right: layer.mask.left + layer.mask.width,
      bottom: layer.mask.top + layer.mask.height,
      // The mask covers all the layer can draw; past it the layer is hidden, as the canvas cuts it at its box.
      defaultColor: 0,
      disabled: layer.mask.disabled,
      imageData: maskData(layer.mask.width, layer.mask.height, layer.mask.pixels)
    }
  }
  if (layer.text !== null) {
    const { text, effects } = await textData(layer.text, fonts)
    result.text = text
    if (effects !== undefined) result.effects = effects
  }
  return result
}

/** An adjustment layer: Photoshop's own kind, with its settings and mask, clipped when it adjusts one layer. */
function adjustmentOf(node: PsdAdjustment): Layer {
  const result: Layer = { name: node.name, hidden: node.hidden, opacity: node.opacity, blendMode: PSD_BLEND_MODES[node.blendMode], clipping: node.clipping, adjustment: toPsdAdjustment(node.settings) }
  if (node.mask !== null && node.mask.width > 0 && node.mask.height > 0) {
    result.mask = {
      left: node.mask.left,
      top: node.mask.top,
      right: node.mask.left + node.mask.width,
      bottom: node.mask.top + node.mask.height,
      // Past the document the adjustment applies, as an adjustment layer's white mask does.
      defaultColor: 255,
      disabled: node.mask.disabled,
      imageData: maskData(node.mask.width, node.mask.height, node.mask.pixels)
    }
  }
  return result
}

async function nodeOf(node: PsdNode, fonts: PsdFontLookup): Promise<Layer> {
  if (node.kind === 'layer') return layerOf(node, fonts)
  if (node.kind === 'adjustment') return adjustmentOf(node)
  const children: Layer[] = []
  for (const child of node.children) children.push(await nodeOf(child, fonts))
  return { name: node.name, hidden: node.hidden, opacity: node.opacity, blendMode: 'pass through', opened: true, children }
}

export async function buildPsd(document: PsdDocument, fonts: PsdFontLookup): Promise<Uint8Array> {
  const children: Layer[] = []
  for (const node of document.children) children.push(await nodeOf(node, fonts))
  const psd: Psd = {
    width: document.width,
    height: document.height,
    channels: 4,
    bitsPerChannel: 8,
    colorMode: 3,
    // 72 pixels an inch, so a font size in pixels is the same number of points in Photoshop.
    imageResources: { resolutionInfo: { horizontalResolution: 72, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: 72, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } },
    children,
    imageData: pixelData(document.width, document.height, document.composite)
  }
  return writePsdUint8Array(psd, { generateThumbnail: false, noBackground: true })
}
