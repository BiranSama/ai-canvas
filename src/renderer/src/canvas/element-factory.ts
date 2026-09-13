import { ELEMENT_SCHEMA_VERSION, type Scene, type SceneElement } from '../../../domain'
import type { CanvasTool } from '../store/workspace-store'

const base = (scene: Scene, type: SceneElement['type'], name: string) => ({
  id: globalThis.crypto.randomUUID(),
  version: ELEMENT_SCHEMA_VERSION,
  type,
  name,
  description: '',
  transform: { x: 0.32, y: 0.32, width: 0.36, height: 0.24, rotation: 0 },
  zIndex: scene.elements.length,
  opacity: 1,
  blendMode: 'normal' as const,
  visible: true,
  locked: false,
  groupId: null,
  semanticRole: 'content',
  referencePolicy: 'include' as const
})

function initialTextFill(scene: Scene): string {
  // The canvas color control stores RGB hex. Keep existing text untouched;
  // this only chooses a readable starting color for a newly inserted layer.
  const hex = scene.canvas.backgroundColor.replace(/^#/, '')
  const rgb = /^[\da-f]{6}$/i.test(hex) ? [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) : [1, 1, 1]
  const linear = rgb.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  const luminance = scene.canvas.transparent ? 1 : .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!
  return luminance < .179 ? '#F4F4F2' : '#172033'
}

export function createElementForTool(tool: CanvasTool, scene: Scene, assetId?: string): SceneElement | null {
  switch (tool) {
    case 'image':
      if (assetId === undefined) return null
      return {
        ...base(scene, 'image', '导入图片'),
        type: 'image',
        assetId,
        crop: { x: 0, y: 0, width: 1, height: 1 },
        fit: 'contain',
        referenceRole: 'general'
      }
    case 'text':
      return {
        ...base(scene, 'text', '文字'),
        type: 'text',
        transform: { x: 0.2, y: 0.25, width: 0.6, height: 0.12, rotation: 0 },
        content: '在这里输入文字',
        orientation: 'horizontal',
        align: 'center',
        wrapping: 'word',
        fontFamily: 'Segoe UI Variable',
        fontSize: 48,
        fontWeight: 400,
        fill: initialTextFill(scene),
        stroke: null,
        strokeWidth: 0,
        shadowColor: null,
        shadowBlur: 0,
        letterSpacing: 6,
        lineHeight: 1.2,
        accuracy: 'balanced',
        visualWeight: 'secondary',
        styleDescription: '作为排版与字效参考；轻盈、克制、与画面气质一致',
        renderStrategy: 'standard',
        resultAssetId: null
      }
    case 'sketch': {
      const strokeId = globalThis.crypto.randomUUID()
      return {
        ...base(scene, 'sketch', '草图'),
        type: 'sketch',
        strokes: [{
          id: strokeId,
          points: [
            { x: 0.08, y: 0.72 },
            { x: 0.24, y: 0.28 },
            { x: 0.52, y: 0.62 },
            { x: 0.88, y: 0.18 }
          ],
          color: '#57708F',
          width: 0.018,
          opacity: 0.85
        }],
        fidelity: 0.7,
        finalVisible: false
      }
    }
    case 'shape':
      return {
        ...base(scene, 'shape', '形状'),
        type: 'shape',
        shape: 'rectangle',
        fill: '#D8E1EB',
        stroke: '#7890AA',
        strokeWidth: 0.003,
        cornerRadius: 0.04,
        role: 'final'
      }
    case 'light': {
      const target = [...scene.elements].reverse().find((element) => element.type !== 'light' && element.type !== 'mask')
      return {
        ...base(scene, 'light', '柔光'),
        type: 'light',
        transform: { x: 0.22, y: 0.12, width: 0.56, height: 0.56, rotation: 0 },
        direction: 35,
        color: '#A7CCFF',
        intensity: 0.65,
        softness: 0.86,
        range: 0.8,
        targetElementIds: target === undefined ? [] : [target.id]
      }
    }
    case 'placeholder':
      return {
        ...base(scene, 'placeholder', '主体占位'),
        type: 'placeholder',
        transform: { x: 0.3, y: 0.3, width: 0.4, height: 0.42, rotation: 0 },
        subject: '需要生成的主体',
        pose: '',
        facing: '',
        allowOverflow: false,
        transparentBackground: true,
        frameShape: 'rectangle',
        generationNotes: ''
      }
    case 'mask': {
      const target = [...scene.elements].reverse().find((element) => element.type !== 'mask' && element.type !== 'group')
      if (target === undefined) return null
      return {
        ...base(scene, 'mask', '修改区域'),
        type: 'mask',
        transform: { ...target.transform },
        mode: 'edit',
        targetElementId: target.id,
        paths: [{
          id: globalThis.crypto.randomUUID(),
          points: [
            { x: 0.16, y: 0.18 },
            { x: 0.84, y: 0.18 },
            { x: 0.84, y: 0.82 },
            { x: 0.16, y: 0.82 }
          ],
          closed: true
        }],
        feather: 0.12
      }
    }
    case 'select':
    case 'hand':
      return null
  }
}
