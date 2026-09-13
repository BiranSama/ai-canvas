import type { SceneElement } from '../../../domain'

export type SimplePropertyId =
  | 'name'
  | 'description'
  | 'opacity'
  | 'blendMode'
  | 'width'
  | 'height'
  | 'content'
  | 'accuracy'
  | 'visualWeight'
  | 'renderStrategy'
  | 'fontFamily'
  | 'fontSize'
  | 'align'
  | 'fill'
  | 'styleDescription'
  | 'fit'
  | 'referenceRole'
  | 'fidelity'
  | 'finalVisible'
  | 'strokeColor'
  | 'strokeWidth'
  | 'shape'
  | 'cornerRadius'
  | 'shapeRole'
  | 'subject'
  | 'pose'
  | 'facing'
  | 'frameShape'
  | 'visualKind'
  | 'allowOverflow'
  | 'transparentBackground'
  | 'lightColor'
  | 'intensity'
  | 'softness'
  | 'direction'
  | 'range'
  | 'maskMode'
  | 'feather'
  | 'referencePolicy'
  | 'visible'
  | 'locked'
  | 'childCount'

export interface SimplePropertyDefinition {
  readonly id: SimplePropertyId
  readonly label: string
  readonly kind: 'text' | 'textarea' | 'number' | 'range' | 'color' | 'select' | 'toggle' | 'readonly'
  readonly group: 'content' | 'appearance' | 'layout' | 'behavior'
}

export type SimplePropertySchema = Readonly<Record<SceneElement['type'], readonly SimplePropertyDefinition[]>>

const field = (
  id: SimplePropertyId,
  label: string,
  kind: SimplePropertyDefinition['kind'],
  group: SimplePropertyDefinition['group']
): SimplePropertyDefinition => ({ id, label, kind, group })

export const simplePropertySchema: SimplePropertySchema = {
  text: [
    field('content', '文字内容', 'textarea', 'content'),
    field('visualWeight', '视觉权重', 'select', 'behavior'),
    field('renderStrategy', '文字用途', 'select', 'behavior'),
    field('styleDescription', '文字风格', 'textarea', 'content'),
    field('fontSize', '字号', 'number', 'appearance'),
    field('align', '对齐', 'select', 'layout'),
    field('blendMode', '混合', 'select', 'appearance')
  ],
  image: [
    field('fit', '适配方式', 'select', 'layout'),
    field('referenceRole', '参考角色', 'select', 'behavior'),
    field('width', '宽度', 'number', 'layout'),
    field('height', '高度', 'number', 'layout'),
    field('opacity', '不透明度', 'range', 'appearance'),
    field('blendMode', '混合', 'select', 'appearance'),
    field('description', '图像描述', 'textarea', 'content')
  ],
  sketch: [
    field('fidelity', '参考强度', 'range', 'behavior'),
    field('strokeColor', '笔触颜色', 'color', 'appearance'),
    field('strokeWidth', '笔触粗细', 'number', 'appearance'),
    field('finalVisible', '最终保留', 'toggle', 'behavior'),
    field('opacity', '不透明度', 'range', 'appearance'),
    field('blendMode', '混合', 'select', 'appearance'),
    field('description', '草图意图', 'textarea', 'content')
  ],
  shape: [
    field('shape', '形态', 'select', 'content'),
    field('fill', '填充', 'color', 'appearance'),
    field('strokeColor', '描边', 'color', 'appearance'),
    field('cornerRadius', '圆角', 'range', 'appearance'),
    field('shapeRole', '用途', 'select', 'behavior'),
    field('opacity', '不透明度', 'range', 'appearance'),
    field('blendMode', '混合', 'select', 'appearance')
  ],
  placeholder: [
    field('subject', '主体', 'text', 'content'),
    field('pose', '姿势 / 形态', 'text', 'content'),
    field('facing', '朝向', 'text', 'content'),
    field('frameShape', '草图轮廓', 'select', 'appearance'),
    field('visualKind', '主题草图', 'select', 'appearance'),
    field('allowOverflow', '允许越界', 'toggle', 'behavior'),
    field('transparentBackground', '透明主体', 'toggle', 'behavior')
  ],
  light: [
    field('lightColor', '光色', 'color', 'appearance'),
    field('intensity', '强度', 'range', 'appearance'),
    field('softness', '柔和', 'range', 'appearance'),
    field('direction', '方向', 'number', 'layout'),
    field('range', '范围', 'range', 'layout'),
    field('blendMode', '混合', 'select', 'appearance')
  ],
  mask: [
    field('maskMode', '区域语义', 'select', 'behavior'),
    field('feather', '羽化', 'range', 'appearance'),
    field('opacity', '显示浓度', 'range', 'appearance'),
    field('referencePolicy', '参考图策略', 'select', 'behavior'),
    field('description', '修改说明', 'textarea', 'content')
  ],
  group: [
    field('name', '组合名称', 'text', 'content'),
    field('childCount', '包含图层', 'readonly', 'content'),
    field('opacity', '整体不透明度', 'range', 'appearance'),
    field('visible', '显示组合', 'toggle', 'behavior'),
    field('locked', '锁定组合', 'toggle', 'behavior'),
    field('referencePolicy', '参考图策略', 'select', 'behavior')
  ]
}

export function simplePropertiesFor(element: SceneElement): readonly SimplePropertyDefinition[] {
  return simplePropertySchema[element.type]
}
