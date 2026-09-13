import { ELEMENT_SCHEMA_VERSION, sceneSchema, type Scene, type SceneElement } from '../../../domain'
import { createBlankScene } from '../scene/create-blank-scene'

export const VISUAL_EXAMPLE_KEYS = ['editorial-portrait', 'nocturne-product', 'graphic-collage', 'botanical-study', 'structural-study'] as const

export type VisualExampleKey = typeof VISUAL_EXAMPLE_KEYS[number]

export const visualExampleLabels: Record<VisualExampleKey, string> = {
  'editorial-portrait': 'Editorial Portrait',
  'nocturne-product': 'Nocturne Product',
  'graphic-collage': 'Graphic Collage',
  'botanical-study': 'Botanical Study',
  'structural-study': 'Structural Study'
}

interface VisualExampleOptions {
  readonly projectId?: string
  readonly sceneId?: string
  readonly now?: string
}

const EXAMPLE_IDS: Record<VisualExampleKey, readonly string[]> = {
  'editorial-portrait': [
    '21000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000002',
    '21000000-0000-4000-8000-000000000003',
    '21000000-0000-4000-8000-000000000004',
    '21000000-0000-4000-8000-000000000005'
  ],
  'nocturne-product': [
    '22000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000002',
    '22000000-0000-4000-8000-000000000003',
    '22000000-0000-4000-8000-000000000004'
  ],
  'graphic-collage': [
    '23000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000002',
    '23000000-0000-4000-8000-000000000003',
    '23000000-0000-4000-8000-000000000004',
    '23000000-0000-4000-8000-000000000005'
  ],
  'botanical-study': [
    '24000000-0000-4000-8000-000000000001',
    '24000000-0000-4000-8000-000000000002',
    '24000000-0000-4000-8000-000000000003',
    '24000000-0000-4000-8000-000000000004'
  ],
  'structural-study': [
    '25000000-0000-4000-8000-000000000001',
    '25000000-0000-4000-8000-000000000002',
    '25000000-0000-4000-8000-000000000003',
    '25000000-0000-4000-8000-000000000004'
  ]
}

function common(id: string, type: SceneElement['type'], name: string, zIndex: number) {
  return {
    id,
    version: ELEMENT_SCHEMA_VERSION,
    type,
    name,
    description: '',
    zIndex,
    opacity: 1,
    visible: true,
    locked: false,
    groupId: null,
    semanticRole: 'content',
    referencePolicy: 'include' as const
  }
}

function editorialPortrait(): { readonly elements: readonly SceneElement[]; readonly canvas: Scene['canvas'] } {
  const [backgroundId, glowId, subjectId, titleId, captionId] = EXAMPLE_IDS['editorial-portrait']
  return {
    canvas: {
      aspectWidth: 4,
      aspectHeight: 5,
      outputWidth: 1024,
      outputHeight: 1280,
      backgroundColor: '#EDE7DD',
      transparent: false,
      globalStyle: '暖白编辑肖像，克制留白，柔和自然光，纸张质感'
    },
    elements: [
      {
        ...common(backgroundId!, 'shape', '暖白背景', 0),
        type: 'shape',
        semanticRole: 'background',
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
        shape: 'rectangle', fill: '#EDE7DD', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final'
      },
      {
        ...common(glowId!, 'light', '窗边柔光', 1),
        type: 'light',
        semanticRole: 'lighting',
        transform: { x: 0.03, y: 0.12, width: 0.65, height: 0.72, rotation: -8 },
        direction: 132, color: '#FFF3DC', intensity: 0.62, softness: 0.92, range: 0.86, targetElementIds: [subjectId!]
      },
      {
        ...common(subjectId!, 'placeholder', '人物半身像', 2),
        type: 'placeholder',
        description: '暖白背景中的人物半身编辑肖像',
        semanticRole: 'subject',
        transform: { x: 0.12, y: 0.25, width: 0.6, height: 0.66, rotation: 0 },
        subject: '人物半身像', pose: '自然侧身', facing: '看向画面右侧', allowOverflow: true, transparentBackground: true,
        frameShape: 'portrait', generationNotes: '自然肤色、干净轮廓，不预设具体人物身份'
      },
      {
        ...common(titleId!, 'text', '刊名', 3),
        type: 'text',
        semanticRole: 'title',
        transform: { x: 0.69, y: 0.12, width: 0.23, height: 0.34, rotation: 0 },
        content: 'FORMA', orientation: 'vertical', align: 'center', wrapping: 'none', fontFamily: 'Georgia', fontSize: 86, fontWeight: 600, fill: '#292A2D', stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0, letterSpacing: 8, lineHeight: 1,
        accuracy: 'strict', styleDescription: '高对比衬线刊名字形，深灰色，细长克制', renderStrategy: 'standard', resultAssetId: null
      },
      {
        ...common(captionId!, 'text', '期刊信息', 4),
        type: 'text',
        semanticRole: 'caption',
        transform: { x: 0.69, y: 0.77, width: 0.23, height: 0.1, rotation: 0 },
        content: 'ISSUE 08 / 2026', orientation: 'horizontal', align: 'end', wrapping: 'word', fontFamily: 'Segoe UI Variable', fontSize: 28, fontWeight: 500, fill: '#34363A', stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0, letterSpacing: 2, lineHeight: 1.2,
        accuracy: 'strict', styleDescription: '小号无衬线信息字，冷静、清晰', renderStrategy: 'standard', resultAssetId: null
      }
    ]
  }
}

function nocturneProduct(): { readonly elements: readonly SceneElement[]; readonly canvas: Scene['canvas'] } {
  const [backgroundId, lightId, subjectId, titleId] = EXAMPLE_IDS['nocturne-product']
  return {
    canvas: {
      aspectWidth: 1,
      aspectHeight: 1,
      outputWidth: 1280,
      outputHeight: 1280,
      backgroundColor: '#171A1F',
      transparent: false,
      globalStyle: '深色陶瓷静物，蓝灰边缘光，低饱和，安静的方形构图'
    },
    elements: [
      {
        ...common(backgroundId!, 'shape', '烟黑背景', 0), type: 'shape', semanticRole: 'background',
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, shape: 'rectangle', fill: '#171A1F', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final'
      },
      {
        ...common(lightId!, 'light', '冷色侧光', 1), type: 'light', semanticRole: 'lighting',
        transform: { x: 0.3, y: 0.08, width: 0.62, height: 0.78, rotation: 18 }, direction: 28, color: '#9BBDE2', intensity: 0.72, softness: 0.84, range: 0.88, targetElementIds: [subjectId!]
      },
      {
        ...common(subjectId!, 'placeholder', '陶瓷静物组合', 2), type: 'placeholder', semanticRole: 'subject',
        transform: { x: 0.2, y: 0.34, width: 0.6, height: 0.5, rotation: 0 }, subject: '陶瓷静物组合', pose: '错落摆放', facing: '正面',
        allowOverflow: false, transparentBackground: true, frameShape: 'ellipse', generationNotes: '哑光陶瓷、石材底座与克制的轮廓反射'
      },
      {
        ...common(titleId!, 'text', '作品标题', 3), type: 'text', semanticRole: 'title',
        transform: { x: 0.09, y: 0.1, width: 0.82, height: 0.12, rotation: 0 }, content: 'STILL / 02', orientation: 'horizontal', align: 'start', wrapping: 'none', fontFamily: 'Segoe UI Variable', fontSize: 70, fontWeight: 350, fill: '#E5E9EE', stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0,
        letterSpacing: 7, lineHeight: 1.1, accuracy: 'strict', styleDescription: '银灰无衬线标题，字距疏朗', renderStrategy: 'standard', resultAssetId: null
      }
    ]
  }
}

function graphicCollage(): { readonly elements: readonly SceneElement[]; readonly canvas: Scene['canvas'] } {
  const [backgroundId, coralId, blueId, limeId, titleId] = EXAMPLE_IDS['graphic-collage']
  const shape = (id: string, name: string, zIndex: number, transform: SceneElement['transform'], fill: string, kind: 'rectangle' | 'ellipse'): SceneElement => ({
    ...common(id, 'shape', name, zIndex),
    type: 'shape', transform, shape: kind, fill, stroke: '#202329', strokeWidth: 0.006, cornerRadius: kind === 'rectangle' ? 0.025 : 0, role: 'final'
  })
  return {
    canvas: {
      aspectWidth: 3,
      aspectHeight: 2,
      outputWidth: 1280,
      outputHeight: 853,
      backgroundColor: '#F2EEDF',
      transparent: false,
      globalStyle: '纸张感图形拼贴，珊瑚红、钴蓝与酸橙绿，清晰硬边'
    },
    elements: [
      {
        ...common(backgroundId!, 'shape', '纸张背景', 0),
        type: 'shape', semanticRole: 'background', transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
        shape: 'rectangle', fill: '#F2EEDF', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final'
      },
      shape(coralId!, '珊瑚矩形', 1, { x: 0.08, y: 0.12, width: 0.5, height: 0.62, rotation: -6 }, '#E86452', 'rectangle'),
      shape(blueId!, '钴蓝圆形', 2, { x: 0.46, y: 0.28, width: 0.36, height: 0.54, rotation: 0 }, '#315CAA', 'ellipse'),
      shape(limeId!, '酸橙色块', 3, { x: 0.66, y: 0.08, width: 0.24, height: 0.34, rotation: 9 }, '#BDD84D', 'rectangle'),
      {
        ...common(titleId!, 'text', '拼贴标题', 4), type: 'text', semanticRole: 'title',
        transform: { x: 0.07, y: 0.77, width: 0.85, height: 0.13, rotation: 0 }, content: 'CUT / FORM / PLAY', orientation: 'horizontal', align: 'start', wrapping: 'none', fontFamily: 'Arial', fontSize: 82, fontWeight: 800, fill: '#202329', stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0,
        letterSpacing: 5, lineHeight: 1, accuracy: 'strict', styleDescription: '厚重几何无衬线黑字', renderStrategy: 'standard', resultAssetId: null
      }
    ]
  }
}

function botanicalStudy(): { readonly elements: readonly SceneElement[]; readonly canvas: Scene['canvas'] } {
  const [backgroundId, lightId, subjectId, titleId] = EXAMPLE_IDS['botanical-study']
  return {
    canvas: {
      aspectWidth: 3,
      aspectHeight: 2,
      outputWidth: 1280,
      outputHeight: 853,
      backgroundColor: '#EFF3EA',
      transparent: false,
      globalStyle: '冷调植物档案标本，薄雾晨光，细脉络与克制留白'
    },
    elements: [
      {
        ...common(backgroundId!, 'shape', '雾白背景', 0), type: 'shape', semanticRole: 'background',
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, shape: 'rectangle', fill: '#EFF3EA', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final'
      },
      {
        ...common(lightId!, 'light', '晨光', 1), type: 'light', semanticRole: 'lighting',
        transform: { x: 0.42, y: 0.04, width: 0.52, height: 0.7, rotation: 12 }, direction: 118, color: '#F4F0DC', intensity: 0.55, softness: 0.9, range: 0.82, targetElementIds: [subjectId!]
      },
      {
        ...common(subjectId!, 'placeholder', '蕨类标本', 2), type: 'placeholder', semanticRole: 'subject',
        transform: { x: 0.3, y: 0.08, width: 0.4, height: 0.78, rotation: 0 }, subject: '蕨类标本', pose: '单枝侧展', facing: '正面',
        allowOverflow: false, transparentBackground: true, frameShape: 'free', visualKind: 'botanical', generationNotes: '细脉络、半透明叶片层次，不预设具体植物种类'
      },
      {
        ...common(titleId!, 'text', '档案编号', 3), type: 'text', semanticRole: 'caption',
        transform: { x: 0.06, y: 0.82, width: 0.3, height: 0.1, rotation: 0 }, content: 'HERBARIUM 04', orientation: 'horizontal', align: 'start', wrapping: 'none', fontFamily: 'Segoe UI Variable', fontSize: 24, fontWeight: 500, fill: '#4C5347',
        stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0, letterSpacing: 4, lineHeight: 1, accuracy: 'strict', styleDescription: '小号档案标注字，灰绿', renderStrategy: 'standard', resultAssetId: null
      }
    ]
  }
}

function structuralStudy(): { readonly elements: readonly SceneElement[]; readonly canvas: Scene['canvas'] } {
  const [backgroundId, subjectId, accentId, titleId] = EXAMPLE_IDS['structural-study']
  return {
    canvas: {
      aspectWidth: 4,
      aspectHeight: 5,
      outputWidth: 1024,
      outputHeight: 1280,
      backgroundColor: '#EDEFF2',
      transparent: false,
      globalStyle: '粗野主义建筑立面研究，硬影、网格秩序与低饱和混凝土'
    },
    elements: [
      {
        ...common(backgroundId!, 'shape', '混凝土底色', 0), type: 'shape', semanticRole: 'background',
        transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, shape: 'rectangle', fill: '#EDEFF2', stroke: null, strokeWidth: 0, cornerRadius: 0, role: 'final'
      },
      {
        ...common(subjectId!, 'placeholder', '建筑立面', 1), type: 'placeholder', semanticRole: 'subject',
        transform: { x: 0.16, y: 0.14, width: 0.56, height: 0.68, rotation: 0 }, subject: '建筑立面', pose: '仰视两点透视', facing: '正立面',
        allowOverflow: false, transparentBackground: true, frameShape: 'rectangle', visualKind: 'architecture', generationNotes: '重复窗格节奏与一处悬挑阴影，强调结构秩序'
      },
      {
        ...common(accentId!, 'placeholder', '抽象色块构成', 2), type: 'placeholder', semanticRole: 'accent',
        transform: { x: 0.68, y: 0.55, width: 0.24, height: 0.3, rotation: 0 }, subject: '抽象色块构成', pose: '静态平衡', facing: '正面',
        allowOverflow: false, transparentBackground: true, frameShape: 'free', visualKind: 'abstract', generationNotes: '低饱和钴蓝与纸白对比，作为立面节奏的平衡块'
      },
      {
        ...common(titleId!, 'text', '研究标题', 3), type: 'text', semanticRole: 'title',
        transform: { x: 0.16, y: 0.86, width: 0.6, height: 0.08, rotation: 0 }, content: 'FACADE STUDY 12', orientation: 'horizontal', align: 'start', wrapping: 'none', fontFamily: 'Segoe UI Variable', fontSize: 34, fontWeight: 600, fill: '#2C3138',
        stroke: null, strokeWidth: 0, shadowColor: null, shadowBlur: 0, letterSpacing: 6, lineHeight: 1, accuracy: 'strict', styleDescription: '中等字重无衬线研究编号', renderStrategy: 'standard', resultAssetId: null
      }
    ]
  }
}

export function createVisualExampleScene(key: VisualExampleKey, options: VisualExampleOptions = {}): Scene {
  const base = createBlankScene(options)
  const fixture = key === 'editorial-portrait'
    ? editorialPortrait()
    : key === 'nocturne-product'
      ? nocturneProduct()
      : key === 'graphic-collage'
        ? graphicCollage()
        : key === 'botanical-study'
          ? botanicalStudy()
          : structuralStudy()
  return sceneSchema.parse({ ...base, canvas: fixture.canvas, elements: fixture.elements })
}
