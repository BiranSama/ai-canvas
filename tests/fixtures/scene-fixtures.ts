import {
  ELEMENT_SCHEMA_VERSION,
  createScene,
  type Scene,
  type SceneElement
} from '../../src/domain'

export const IDS = {
  scene: '00000000-0000-4000-8000-000000000001',
  project: '00000000-0000-4000-8000-000000000002',
  image: '00000000-0000-4000-8000-000000000003',
  asset: '00000000-0000-4000-8000-000000000004',
  text: '00000000-0000-4000-8000-000000000005',
  sketch: '00000000-0000-4000-8000-000000000006',
  stroke: '00000000-0000-4000-8000-000000000007',
  shape: '00000000-0000-4000-8000-000000000008',
  placeholder: '00000000-0000-4000-8000-000000000009',
  light: '00000000-0000-4000-8000-000000000010',
  mask: '00000000-0000-4000-8000-000000000011',
  maskPath: '00000000-0000-4000-8000-000000000012',
  group: '00000000-0000-4000-8000-000000000013',
  relation: '00000000-0000-4000-8000-000000000014',
  batch1: '00000000-0000-4000-8000-000000000015',
  batch2: '00000000-0000-4000-8000-000000000016'
} as const

const base = {
  version: ELEMENT_SCHEMA_VERSION,
  description: '',
  opacity: 1,
  visible: true,
  locked: false,
  groupId: null,
  semanticRole: 'content',
  referencePolicy: 'include' as const
}

export function makeImage(zIndex = 0): SceneElement {
  return {
    ...base,
    id: IDS.image,
    type: 'image',
    name: '香水瓶',
    transform: { x: 0.32, y: 0.32, width: 0.36, height: 0.54, rotation: 0 },
    zIndex,
    assetId: IDS.asset,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    fit: 'contain',
    referenceRole: 'subject'
  }
}

export function makeText(zIndex = 0): SceneElement {
  return {
    ...base,
    id: IDS.text,
    type: 'text',
    name: '主标题',
    transform: { x: 0.12, y: 0.08, width: 0.76, height: 0.12, rotation: 0 },
    zIndex,
    content: 'NIGHT VEIL',
    orientation: 'horizontal',
    align: 'center',
    wrapping: 'none',
    fontFamily: 'Segoe UI Variable',
    fontSize: 84,
    fontWeight: 300,
    fill: '#EAF0F5',
    stroke: null,
    strokeWidth: 0,
    shadowColor: null,
    shadowBlur: 0,
    letterSpacing: 18,
    lineHeight: 1.2,
    accuracy: 'strict',
    styleDescription: '窄体银色金属字，柔和边缘光',
    renderStrategy: 'standard',
    resultAssetId: null
  }
}

export function makeAllElementTypesScene(): Scene {
  const scene = createScene({ id: IDS.scene, projectId: IDS.project, now: '2026-08-10T00:00:00.000Z' })
  const elements: SceneElement[] = [
    makeImage(0),
    makeText(1),
    {
      ...base,
      id: IDS.sketch,
      type: 'sketch',
      name: '构图草图',
      transform: { x: 0.1, y: 0.2, width: 0.8, height: 0.6, rotation: 0 },
      zIndex: 2,
      strokes: [{ id: IDS.stroke, points: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.8 }], color: '#202329', width: 0.01, opacity: 0.8 }],
      fidelity: 0.7,
      finalVisible: false
    },
    {
      ...base,
      id: IDS.shape,
      type: 'shape',
      name: '背景形状',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      zIndex: 3,
      shape: 'rectangle',
      fill: '#111827',
      stroke: null,
      strokeWidth: 0,
      cornerRadius: 0,
      role: 'final'
    },
    {
      ...base,
      id: IDS.placeholder,
      type: 'placeholder',
      name: '商品占位',
      transform: { x: 0.36, y: 0.35, width: 0.28, height: 0.46, rotation: 0 },
      zIndex: 4,
      subject: '透明玻璃香水瓶',
      pose: '正面直立',
      facing: '正面',
      allowOverflow: false,
      transparentBackground: true,
      frameShape: 'rectangle',
      generationNotes: '保留瓶身对称轮廓'
    },
    {
      ...base,
      id: IDS.light,
      type: 'light',
      name: '蓝色背光',
      transform: { x: 0.25, y: 0.08, width: 0.5, height: 0.82, rotation: 0 },
      zIndex: 5,
      direction: 18,
      color: '#6AA9FF',
      intensity: 0.72,
      softness: 0.84,
      range: 0.9,
      targetElementIds: [IDS.image]
    },
    {
      ...base,
      id: IDS.mask,
      type: 'mask',
      name: '瓶身修改区',
      transform: { x: 0.32, y: 0.32, width: 0.36, height: 0.54, rotation: 0 },
      zIndex: 6,
      mode: 'edit',
      targetElementId: IDS.image,
      paths: [{ id: IDS.maskPath, points: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.5, y: 0.8 }], closed: true }],
      feather: 0.05
    }
  ]

  return { ...scene, elements }
}
