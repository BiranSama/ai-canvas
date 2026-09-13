import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDown,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  ChevronRight,
  Search,
  Copy,
  Eye,
  EyeOff,
  Group as GroupIcon,
  GripVertical,
  Lock,
  Link2,
  PanelRightClose,
  Rows3,
  SlidersHorizontal,
  Trash2,
  Unlock,
  Unlink2,
  Ungroup
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Canvas, SceneElement } from '../../../domain'
import { BLEND_MODES, blendModeLabel, elementSupportsBlendMode, resolveBlendMode } from '../../../shared/blend-mode'
import { useWorkspaceStore } from '../store/workspace-store'
import { CanvasSizeControl } from './CanvasSizeControl'
import { ImeSafeInput, ImeSafeTextarea } from './ImeSafeTextField'
import { simplePropertiesFor, type SimplePropertyDefinition } from '../inspector/property-schema'

const elementLabels: Record<SceneElement['type'], string> = {
  image: '图片',
  text: '文字',
  sketch: '草图',
  shape: '形状',
  placeholder: '主体',
  light: '光影',
  mask: '蒙版',
  group: '组合'
}

function NumberField({ label, value, onChange, step = 0.01 }: { label: string; value: number; onChange(value: number): void; step?: number }): React.JSX.Element {
  return (
    <label className="compact-field">
      <span>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(3))}
        step={step}
        onChange={(event) => {
          const next = Number(event.currentTarget.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
    </label>
  )
}

function CanvasProperties({ canvas }: { canvas: Canvas }): React.JSX.Element {
  const execute = useWorkspaceStore((state) => state.execute)
  const update = (changes: Partial<Canvas>): void => {
    execute('调整画布', [{ kind: 'scene.set-canvas', canvas: { ...canvas, ...changes } }])
  }
  return (
    <div className="inspector-section canvas-properties">
      <p className="section-kicker">画布</p>
      <CanvasSizeControl key={`${canvas.aspectWidth}:${canvas.aspectHeight}:${canvas.outputWidth}:${canvas.outputHeight}`} inspector />
      <label className="color-field"><span>背景颜色</span><input type="color" value={canvas.backgroundColor} onChange={(event) => update({ backgroundColor: event.currentTarget.value })} /></label>
      <label className="checkbox-field"><input type="checkbox" checked={canvas.transparent} onChange={(event) => update({ transparent: event.currentTarget.checked })} /><span>PNG / WebP 保留透明背景</span></label>
      <label className="wide-field">
        <span>整体风格</span>
        <ImeSafeTextarea value={canvas.globalStyle} onCommit={(value) => update({ globalStyle: value })} rows={3} />
      </label>
    </div>
  )
}

const selectOptions: Partial<Record<SimplePropertyDefinition['id'], readonly { readonly value: string; readonly label: string }[]>> = {
  accuracy: [{ value: 'strict', label: '严格准确' }, { value: 'balanced', label: '平衡' }, { value: 'expressive', label: '允许表现' }],
  visualWeight: [{ value: 'whisper', label: '轻声点缀' }, { value: 'secondary', label: '次要信息' }, { value: 'primary', label: '主要信息' }, { value: 'hero', label: '主视觉' }],
  renderStrategy: [{ value: 'standard', label: '排版与字效参考' }, { value: 'ai-material', label: 'AI 字效素材' }, { value: 'ai-complete', label: 'AI 完整文字' }, { value: 'editable-overlay', label: '准确可编辑叠字' }],
  align: [{ value: 'start', label: '左对齐' }, { value: 'center', label: '居中' }, { value: 'end', label: '右对齐' }, { value: 'justify', label: '两端' }],
  fit: [{ value: 'contain', label: '完整显示' }, { value: 'cover', label: '填满裁切' }, { value: 'fill', label: '自由拉伸' }],
  referenceRole: [{ value: 'general', label: '普通元素' }, { value: 'subject', label: '主体参考' }, { value: 'style', label: '风格参考' }, { value: 'composition', label: '构图参考' }, { value: 'color', label: '色彩参考' }, { value: 'material', label: '材质参考' }],
  shape: [{ value: 'rectangle', label: '矩形' }, { value: 'ellipse', label: '椭圆' }, { value: 'line', label: '线条' }],
  shapeRole: [{ value: 'final', label: '作品元素' }, { value: 'placeholder', label: '构图占位' }],
  frameShape: [{ value: 'rectangle', label: '构图框' }, { value: 'ellipse', label: '椭圆' }, { value: 'portrait', label: '人物头肩' }, { value: 'free', label: '自由轮廓' }],
  visualKind: [{ value: 'generic', label: '中性构图' }, { value: 'product', label: '产品结构' }, { value: 'portrait', label: '人物姿态' }, { value: 'architecture', label: '建筑体块' }, { value: 'botanical', label: '植物枝叶' }, { value: 'abstract', label: '抽象构成' }, { value: 'album', label: '唱片封面' }, { value: 'coffee', label: '咖啡杯碟' }, { value: 'landscape', label: '山海层次' }],
  maskMode: [{ value: 'edit', label: '修改区' }, { value: 'protect', label: '保护区' }, { value: 'generate', label: '生成区' }],
  referencePolicy: [{ value: 'include', label: '纳入参考图' }, { value: 'reference-only', label: '仅作参考' }, { value: 'exclude', label: '排除' }],
  blendMode: BLEND_MODES.map((value) => ({ value, label: blendModeLabel(value) }))
}

function SimpleElementProperties({ element, canvas, horizontal }: { element: SceneElement; canvas: Canvas; horizontal: boolean }): React.JSX.Element {
  const updateElement = useWorkspaceStore((state) => state.updateElement)
  const schema = simplePropertiesFor(element)
  const numericValue = (property: SimplePropertyDefinition): number => {
    switch (property.id) {
      case 'width': return Math.round(element.transform.width * canvas.outputWidth)
      case 'height': return Math.round(element.transform.height * canvas.outputHeight)
      case 'opacity': return element.opacity
      case 'fontSize': return element.type === 'text' ? element.fontSize : 0
      case 'fidelity': return element.type === 'sketch' ? element.fidelity : 0
      case 'strokeWidth': return element.type === 'sketch' ? (element.strokes[0]?.width ?? 0) : element.type === 'shape' ? element.strokeWidth : 0
      case 'cornerRadius': return element.type === 'shape' ? element.cornerRadius : 0
      case 'intensity': return element.type === 'light' ? element.intensity : 0
      case 'softness': return element.type === 'light' ? element.softness : 0
      case 'direction': return element.type === 'light' ? element.direction : 0
      case 'range': return element.type === 'light' ? element.range : 0
      case 'feather': return element.type === 'mask' ? element.feather : 0
      default: return 0
    }
  }
  const stringValue = (property: SimplePropertyDefinition): string => {
    switch (property.id) {
      case 'name': return element.name
      case 'description': return element.description
      case 'content': return element.type === 'text' ? element.content : ''
      case 'accuracy': return element.type === 'text' ? element.accuracy : ''
      case 'visualWeight': return element.type === 'text' ? (element.visualWeight ?? 'secondary') : ''
      case 'renderStrategy': return element.type === 'text' ? element.renderStrategy : ''
      case 'fontFamily': return element.type === 'text' ? element.fontFamily : ''
      case 'align': return element.type === 'text' ? element.align : ''
      case 'fill': return element.type === 'text' || element.type === 'shape' ? element.fill : '#000000'
      case 'styleDescription': return element.type === 'text' ? element.styleDescription : ''
      case 'fit': return element.type === 'image' ? element.fit : ''
      case 'referenceRole': return element.type === 'image' ? element.referenceRole : ''
      case 'strokeColor': return element.type === 'sketch' ? (element.strokes[0]?.color ?? '#57708F') : element.type === 'shape' ? (element.stroke ?? '#7890AA') : '#7890AA'
      case 'shape': return element.type === 'shape' ? element.shape : ''
      case 'shapeRole': return element.type === 'shape' ? element.role : ''
      case 'subject': return element.type === 'placeholder' ? element.subject : ''
      case 'pose': return element.type === 'placeholder' ? element.pose : ''
      case 'facing': return element.type === 'placeholder' ? element.facing : ''
      case 'frameShape': return element.type === 'placeholder' ? element.frameShape : ''
      case 'visualKind': return element.type === 'placeholder' ? (element.visualKind ?? 'generic') : ''
      case 'lightColor': return element.type === 'light' ? element.color : '#A7CCFF'
      case 'maskMode': return element.type === 'mask' ? element.mode : ''
      case 'referencePolicy': return element.referencePolicy
      case 'blendMode': return resolveBlendMode(element)
      case 'childCount': return element.type === 'group' ? `${element.childIds.length} 个图层` : ''
      default: return ''
    }
  }
  const booleanValue = (property: SimplePropertyDefinition): boolean => {
    switch (property.id) {
      case 'finalVisible': return element.type === 'sketch' && element.finalVisible
      case 'allowOverflow': return element.type === 'placeholder' && element.allowOverflow
      case 'transparentBackground': return element.type === 'placeholder' && element.transparentBackground
      case 'visible': return element.visible
      case 'locked': return element.locked
      default: return false
    }
  }
  const updateNumber = (property: SimplePropertyDefinition, value: number): void => {
    if (!Number.isFinite(value)) return
    switch (property.id) {
      case 'width': updateElement(element.id, { transform: { ...element.transform, width: Math.max(.001, value / canvas.outputWidth) } }); break
      case 'height': updateElement(element.id, { transform: { ...element.transform, height: Math.max(.001, value / canvas.outputHeight) } }); break
      case 'opacity': updateElement(element.id, { opacity: Math.min(1, Math.max(0, value)) }); break
      case 'fontSize': if (element.type === 'text') updateElement(element.id, { fontSize: Math.min(512, Math.max(8, value)) }); break
      case 'fidelity': if (element.type === 'sketch') updateElement(element.id, { fidelity: Math.min(1, Math.max(0, value)) }); break
      case 'strokeWidth':
        if (element.type === 'sketch') updateElement(element.id, { strokes: element.strokes.map((stroke) => ({ ...stroke, width: Math.min(1, Math.max(.001, value)) })) })
        if (element.type === 'shape') updateElement(element.id, { strokeWidth: Math.min(1, Math.max(0, value)) })
        break
      case 'cornerRadius': if (element.type === 'shape') updateElement(element.id, { cornerRadius: Math.min(.5, Math.max(0, value)) }); break
      case 'intensity': if (element.type === 'light') updateElement(element.id, { intensity: Math.min(1, Math.max(0, value)) }); break
      case 'softness': if (element.type === 'light') updateElement(element.id, { softness: Math.min(1, Math.max(0, value)) }); break
      case 'direction': if (element.type === 'light') updateElement(element.id, { direction: value }); break
      case 'range': if (element.type === 'light') updateElement(element.id, { range: Math.min(4, Math.max(.01, value)) }); break
      case 'feather': if (element.type === 'mask') updateElement(element.id, { feather: Math.min(1, Math.max(0, value)) }); break
    }
  }
  const updateString = (property: SimplePropertyDefinition, value: string): void => {
    switch (property.id) {
      case 'name': updateElement(element.id, { name: value || elementLabels[element.type] }); break
      case 'description': updateElement(element.id, { description: value }); break
      case 'content': if (element.type === 'text') updateElement(element.id, { content: value }); break
      case 'accuracy': if (element.type === 'text') updateElement(element.id, { accuracy: value }); break
      case 'visualWeight': if (element.type === 'text') updateElement(element.id, { visualWeight: value }); break
      case 'renderStrategy': if (element.type === 'text') updateElement(element.id, { renderStrategy: value }); break
      case 'fontFamily': if (element.type === 'text') updateElement(element.id, { fontFamily: value || 'Segoe UI Variable' }); break
      case 'align': if (element.type === 'text') updateElement(element.id, { align: value }); break
      case 'fill': if (element.type === 'text' || element.type === 'shape') updateElement(element.id, { fill: value }); break
      case 'styleDescription': if (element.type === 'text') updateElement(element.id, { styleDescription: value }); break
      case 'fit': if (element.type === 'image') updateElement(element.id, { fit: value }); break
      case 'referenceRole': if (element.type === 'image') updateElement(element.id, { referenceRole: value }); break
      case 'strokeColor':
        if (element.type === 'sketch') updateElement(element.id, { strokes: element.strokes.map((stroke) => ({ ...stroke, color: value })) })
        if (element.type === 'shape') updateElement(element.id, { stroke: value })
        break
      case 'shape': if (element.type === 'shape') updateElement(element.id, { shape: value }); break
      case 'shapeRole': if (element.type === 'shape') updateElement(element.id, { role: value }); break
      case 'subject': if (element.type === 'placeholder') updateElement(element.id, { subject: value || '主体' }); break
      case 'pose': if (element.type === 'placeholder') updateElement(element.id, { pose: value }); break
      case 'facing': if (element.type === 'placeholder') updateElement(element.id, { facing: value }); break
      case 'frameShape': if (element.type === 'placeholder') updateElement(element.id, { frameShape: value }); break
      case 'visualKind': if (element.type === 'placeholder') updateElement(element.id, { visualKind: value }); break
      case 'lightColor': if (element.type === 'light') updateElement(element.id, { color: value }); break
      case 'maskMode': if (element.type === 'mask') updateElement(element.id, { mode: value }); break
      case 'referencePolicy': updateElement(element.id, { referencePolicy: value }); break
      case 'blendMode': if (elementSupportsBlendMode(element.type)) updateElement(element.id, { blendMode: value }, `将“${element.name}”混合改为${blendModeLabel(value as Parameters<typeof blendModeLabel>[0])}`); break
    }
  }
  const updateBoolean = (property: SimplePropertyDefinition, value: boolean): void => {
    switch (property.id) {
      case 'finalVisible': if (element.type === 'sketch') updateElement(element.id, { finalVisible: value }); break
      case 'allowOverflow': if (element.type === 'placeholder') updateElement(element.id, { allowOverflow: value }); break
      case 'transparentBackground': if (element.type === 'placeholder') updateElement(element.id, { transparentBackground: value }); break
      case 'visible': updateElement(element.id, { visible: value }); break
      case 'locked': updateElement(element.id, { locked: value }); break
    }
  }
  return (
    <fieldset disabled={element.locked} className={`simple-property-grid${horizontal ? ' is-horizontal' : ''}`} data-property-schema={element.type}>
      {element.locked && <legend>图层已锁定，请先在图层列表解锁。</legend>}
      {schema.map((property) => {
        if (property.kind === 'readonly') return <div key={property.id} className="simple-property-field is-readonly"><span>{property.label}</span><strong>{stringValue(property)}</strong></div>
        if (property.kind === 'toggle') return <label key={property.id} className="simple-property-field is-toggle"><span>{property.label}</span><input aria-label={property.label} type="checkbox" checked={booleanValue(property)} onChange={(event) => updateBoolean(property, event.currentTarget.checked)} /></label>
        if (property.kind === 'select') return <label key={property.id} className="simple-property-field"><span>{property.label}</span><select aria-label={property.label} value={stringValue(property)} onChange={(event) => updateString(property, event.currentTarget.value)}>{selectOptions[property.id]?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        if (property.kind === 'color') return <label key={property.id} className="simple-property-field is-color"><span>{property.label}</span><input aria-label={property.label} type="color" value={stringValue(property)} onInput={(event) => updateString(property, event.currentTarget.value)} /></label>
        if (property.kind === 'textarea') return <label key={property.id} className="simple-property-field is-textarea"><span>{property.label}</span><ImeSafeTextarea aria-label={property.label} rows={horizontal ? 1 : 2} value={stringValue(property)} onCommit={(value) => updateString(property, value)} /></label>
        if (property.kind === 'text') return <label key={property.id} className="simple-property-field"><span>{property.label}</span><ImeSafeInput aria-label={property.label} value={stringValue(property)} onCommit={(value) => updateString(property, value)} /></label>
        const value = numericValue(property)
        const range = ['opacity', 'fidelity', 'cornerRadius', 'intensity', 'softness', 'feather'].includes(property.id)
        return <label key={property.id} className={`simple-property-field${range ? ' is-range' : ''}`}><span>{property.label}</span><input aria-label={property.label} type={range ? 'range' : 'number'} min={range ? 0 : undefined} max={range ? 1 : undefined} step={range ? .01 : 1} value={value} onChange={(event) => updateNumber(property, Number(event.currentTarget.value))} /></label>
      })}
    </fieldset>
  )
}

function ElementProperties({ element, canvas, search = '' }: { element: SceneElement; canvas: Canvas; search?: string }): React.JSX.Element {
  const updateElement = useWorkspaceStore((state) => state.updateElement)
  const ratioLocked = useWorkspaceStore((state) => state.transformRatioLocked)
  const setRatioLocked = useWorkspaceStore((state) => state.setTransformRatioLocked)
  const geometryUnit = useWorkspaceStore((state) => state.geometryUnit)
  const setGeometryUnit = useWorkspaceStore((state) => state.setGeometryUnit)
  const updateTransform = (changes: Partial<SceneElement['transform']>): void => {
    updateElement(element.id, { transform: { ...element.transform, ...changes } }, `调整“${element.name}”`)
  }
  const project = (value: number, axis: 'x' | 'y'): number => geometryUnit === 'px'
    ? value * (axis === 'x' ? canvas.outputWidth : canvas.outputHeight)
    : value * 100
  const unproject = (value: number, axis: 'x' | 'y'): number => geometryUnit === 'px'
    ? value / (axis === 'x' ? canvas.outputWidth : canvas.outputHeight)
    : value / 100
  const updateSize = (axis: 'width' | 'height', projectedValue: number): void => {
    const normalized = Math.max(0.001, unproject(projectedValue, axis === 'width' ? 'x' : 'y'))
    if (!ratioLocked) {
      updateTransform({ [axis]: normalized })
      return
    }
    if (axis === 'width') {
      const scale = normalized / element.transform.width
      updateTransform({ width: normalized, height: Math.max(0.001, element.transform.height * scale) })
    } else {
      const scale = normalized / element.transform.height
      updateTransform({ height: normalized, width: Math.max(0.001, element.transform.width * scale) })
    }
  }
  const query = search.trim().toLocaleLowerCase()
  const showSection = (keywords: string): boolean => query === '' || keywords.toLocaleLowerCase().includes(query)
  return (
    <>
      {showSection('名称 描述 语义 identity name description') && <div className="inspector-section element-identity">
        <p className="section-kicker">{elementLabels[element.type]}</p>
        <label className="wide-field">
          <span>名称</span>
          <ImeSafeInput value={element.name} disabled={element.locked} onCommit={(value) => updateElement(element.id, { name: value.trim() || elementLabels[element.type] }, '重命名图层')} />
        </label>
        <label className="wide-field">
          <span>描述</span>
          <ImeSafeTextarea value={element.description} disabled={element.locked} onCommit={(value) => updateElement(element.id, { description: value })} rows={3} placeholder="告诉 AI 这个元素是什么、应该如何呈现" />
        </label>
        {element.controlIntent !== undefined && <div className="element-semantic-contract">
          <span>{element.controlIntent.priority === 'must' ? '必须保持' : element.controlIntent.priority === 'prefer' ? '优先保持' : '构图参考'}</span>
          <strong>{element.controlIntent.kind}</strong>
          <small>{element.controlIntent.instruction}</small>
          <small>来源：{element.provenance?.origin ?? '未记录'}</small>
        </div>}
      </div>}
      {showSection('位置 尺寸 宽度 高度 旋转 不透明度 geometry position size opacity') && <div className="inspector-section element-geometry">
        <div className="geometry-heading">
          <p className="section-kicker">位置与尺寸</p>
          <div className="geometry-units" aria-label="几何单位">
            <button type="button" className={geometryUnit === 'px' ? 'is-active' : ''} onClick={() => setGeometryUnit('px')}>px</button>
            <button type="button" className={geometryUnit === 'percent' ? 'is-active' : ''} onClick={() => setGeometryUnit('percent')}>%</button>
          </div>
        </div>
        <div className="field-grid two-columns">
          <NumberField label="X" value={project(element.transform.x, 'x')} step={geometryUnit === 'px' ? 1 : 0.1} onChange={(value) => updateTransform({ x: unproject(value, 'x') })} />
          <NumberField label="Y" value={project(element.transform.y, 'y')} step={geometryUnit === 'px' ? 1 : 0.1} onChange={(value) => updateTransform({ y: unproject(value, 'y') })} />
          <NumberField label="W" value={project(element.transform.width, 'x')} step={geometryUnit === 'px' ? 1 : 0.1} onChange={(value) => updateSize('width', value)} />
          <NumberField label="H" value={project(element.transform.height, 'y')} step={geometryUnit === 'px' ? 1 : 0.1} onChange={(value) => updateSize('height', value)} />
          <NumberField label="旋转" value={element.transform.rotation} step={1} onChange={(value) => updateTransform({ rotation: value })} />
          <NumberField label="不透明度" value={element.opacity} onChange={(value) => updateElement(element.id, { opacity: Math.min(1, Math.max(0, value)) })} />
        </div>
        <button type="button" className={`ratio-lock${ratioLocked ? ' is-active' : ''}`} aria-pressed={ratioLocked} onClick={() => setRatioLocked(!ratioLocked)}>
          {ratioLocked ? <Link2 size={13} /> : <Unlink2 size={13} />}{ratioLocked ? '已锁定宽高比例' : '自由改变宽高'}
        </button>
      </div>}
      {elementSupportsBlendMode(element.type) && showSection('混合 模式 正片叠底 滤色 叠加 柔光 blend mode multiply screen overlay soft-light') && <div className="inspector-section element-blend">
        <p className="section-kicker">图层混合</p>
        <label className="wide-field"><span>混合</span><select aria-label="混合" value={resolveBlendMode(element)} onChange={(event) => {
          const blendMode = event.currentTarget.value as Parameters<typeof blendModeLabel>[0]
          updateElement(element.id, { blendMode }, `将“${element.name}”混合改为${blendModeLabel(blendMode)}`)
        }}>{BLEND_MODES.map((blendMode) => <option key={blendMode} value={blendMode}>{blendModeLabel(blendMode)}</option>)}</select></label>
        <p className="field-note">混合只作用于作品元素；工具玻璃与选择控件不参与合成。</p>
      </div>}
      {element.type === 'text' && (
        <>
          {showSection('文字内容 准确文字 准确度 方向 content accuracy orientation') && <details className="inspector-section text-content-section advanced-section" open>
            <summary>文字内容</summary>
            <p className="section-kicker">文字内容</p>
            <label className="wide-field">
              <span>文字内容</span>
              <ImeSafeTextarea data-text-content={element.id} value={element.content} onCommit={(value) => updateElement(element.id, { content: value })} rows={3} />
            </label>
            <div className="field-grid two-columns">
              <label className="wide-field"><span>准确度</span><select value={element.accuracy} onChange={(event) => updateElement(element.id, { accuracy: event.currentTarget.value })}><option value="strict">严格准确</option><option value="balanced">平衡</option><option value="expressive">允许表现</option></select></label>
              <label className="wide-field"><span>方向</span><select value={element.orientation} onChange={(event) => updateElement(element.id, { orientation: event.currentTarget.value })}><option value="horizontal">横排</option><option value="vertical">竖排</option></select></label>
              <label className="wide-field"><span>视觉权重</span><select value={element.visualWeight ?? 'secondary'} onChange={(event) => updateElement(element.id, { visualWeight: event.currentTarget.value })}><option value="whisper">低语 / 点缀</option><option value="secondary">次要</option><option value="primary">主要</option><option value="hero">主视觉</option></select></label>
            </div>
            <p className="field-note">文字框表示参考区域，不等于最终字号。只有“主视觉”会主动强调大字。</p>
          </details>}
          {showSection('排版 字体 字号 字重 对齐 换行 字距 行距 颜色 typography font align color') && <details className="inspector-section text-typography-section advanced-section" open>
            <summary>排版</summary>
            <p className="section-kicker">排版</p>
            <label className="wide-field"><span>字体参考</span><ImeSafeInput value={element.fontFamily} onCommit={(value) => updateElement(element.id, { fontFamily: value.trim() || 'Segoe UI Variable' })} /></label>
            <div className="field-grid two-columns">
              <NumberField label="字号 px" value={element.fontSize} step={1} onChange={(value) => updateElement(element.id, { fontSize: Math.min(512, Math.max(8, value)) })} />
              <label className="wide-field"><span>字重</span><select aria-label="字重" value={element.fontWeight} onChange={(event) => updateElement(element.id, { fontWeight: Number(event.currentTarget.value) })}>{[300, 400, 500, 600, 700, 800].map((weight) => <option key={weight} value={weight}>{weight}</option>)}</select></label>
              <label className="wide-field"><span>对齐</span><select value={element.align} onChange={(event) => updateElement(element.id, { align: event.currentTarget.value })}><option value="start">左对齐</option><option value="center">居中</option><option value="end">右对齐</option><option value="justify">两端</option></select></label>
              <label className="wide-field"><span>换行</span><select value={element.wrapping} onChange={(event) => updateElement(element.id, { wrapping: event.currentTarget.value })}><option value="none">不换行</option><option value="word">按词</option><option value="character">按字</option></select></label>
              <NumberField label="字距" value={element.letterSpacing} step={1} onChange={(value) => updateElement(element.id, { letterSpacing: value })} />
              <NumberField label="行距" value={element.lineHeight} onChange={(value) => updateElement(element.id, { lineHeight: value })} />
            </div>
            <label className="color-field"><span>文字颜色</span><input type="color" value={element.fill} onInput={(event) => updateElement(element.id, { fill: event.currentTarget.value })} /></label>
          </details>}
          {showSection('描边 阴影 模糊 effects stroke shadow blur') && <details className="inspector-section text-effects-section advanced-section">
            <summary>描边与阴影</summary>
            <p className="section-kicker">描边与阴影</p>
            <label className="checkbox-field"><input type="checkbox" checked={element.stroke !== null} onChange={(event) => updateElement(element.id, { stroke: event.currentTarget.checked ? '#202329' : null })} /><span>启用文字描边</span></label>
            {element.stroke !== null && <><label className="color-field"><span>描边颜色</span><input type="color" value={element.stroke} onInput={(event) => updateElement(element.id, { stroke: event.currentTarget.value })} /></label><NumberField label="描边 px" value={element.strokeWidth} step={0.5} onChange={(value) => updateElement(element.id, { strokeWidth: Math.min(32, Math.max(0, value)) })} /></>}
            <label className="checkbox-field"><input type="checkbox" checked={element.shadowColor !== null} onChange={(event) => updateElement(element.id, { shadowColor: event.currentTarget.checked ? '#202329' : null })} /><span>启用柔和阴影</span></label>
            {element.shadowColor !== null && <><label className="color-field"><span>阴影颜色</span><input type="color" value={element.shadowColor} onInput={(event) => updateElement(element.id, { shadowColor: event.currentTarget.value })} /></label><NumberField label="模糊 px" value={element.shadowBlur} step={1} onChange={(value) => updateElement(element.id, { shadowBlur: Math.min(128, Math.max(0, value)) })} /></>}
          </details>}
          {showSection('AI 文字风格 呈现方式 材质 style render strategy') && <details className="inspector-section text-ai-section advanced-section">
            <summary>AI 文字风格</summary>
            <p className="section-kicker">AI 文字风格</p>
            <label className="wide-field"><span>风格描述</span><ImeSafeTextarea value={element.styleDescription} onCommit={(value) => updateElement(element.id, { styleDescription: value })} rows={3} /></label>
            <label className="wide-field"><span>呈现方式</span><select value={element.renderStrategy} onChange={(event) => updateElement(element.id, { renderStrategy: event.currentTarget.value })}><option value="standard">排版与字效参考</option><option value="ai-material">AI 生成材质字</option><option value="ai-complete">完整 AI 字效图片</option><option value="editable-overlay">最终可编辑文字</option></select></label>
            <p className="field-note">参考模式允许 AI 重新设计字形；最终可编辑文字只让背景预留空间，由当前文字图层完成成稿。</p>
          </details>}
        </>
      )}
      {element.type === 'placeholder' && showSection('主体语义 占位形态 姿势 朝向 越界 生成说明 subject pose frame generation') && (
        <div className="inspector-section">
          <p className="section-kicker">主体语义</p>
          <label className="wide-field"><span>主体</span><ImeSafeInput value={element.subject} onCommit={(value) => updateElement(element.id, { subject: value.trim() || '主体' })} /></label>
          <label className="wide-field"><span>占位形态</span><select value={element.frameShape} onChange={(event) => updateElement(element.id, { frameShape: event.currentTarget.value })}><option value="rectangle">构图框</option><option value="ellipse">椭圆</option><option value="portrait">人物头肩</option><option value="free">自由轮廓</option></select></label>
          <label className="wide-field"><span>主题草图</span><select value={element.visualKind ?? 'generic'} onChange={(event) => updateElement(element.id, { visualKind: event.currentTarget.value })}><option value="generic">中性构图</option><option value="product">产品结构</option><option value="portrait">人物姿态</option><option value="architecture">建筑体块</option><option value="botanical">植物枝叶</option><option value="abstract">抽象构成</option><option value="album">唱片封面</option><option value="coffee">咖啡杯碟</option><option value="landscape">山海层次</option></select></label>
          <label className="wide-field"><span>姿势 / 形态</span><ImeSafeInput value={element.pose} onCommit={(value) => updateElement(element.id, { pose: value })} /></label>
          <label className="wide-field"><span>朝向</span><ImeSafeInput value={element.facing} onCommit={(value) => updateElement(element.id, { facing: value })} /></label>
          <label className="checkbox-field"><input type="checkbox" checked={element.allowOverflow} onChange={(event) => updateElement(element.id, { allowOverflow: event.currentTarget.checked })} /><span>允许主体越出画布</span></label>
          <label className="wide-field"><span>生成说明</span><ImeSafeTextarea value={element.generationNotes} onCommit={(value) => updateElement(element.id, { generationNotes: value })} rows={3} /></label>
        </div>
      )}
      {element.type === 'light' && showSection('光影 颜色 强度 柔和 方向 范围 light color intensity softness direction range') && (
        <div className="inspector-section">
          <p className="section-kicker">光影</p>
          <label className="color-field"><span>颜色</span><input type="color" value={element.color} onChange={(event) => updateElement(element.id, { color: event.currentTarget.value })} /></label>
          <div className="field-grid two-columns">
            <NumberField label="强度" value={element.intensity} onChange={(value) => updateElement(element.id, { intensity: Math.min(1, Math.max(0, value)) })} />
            <NumberField label="柔和" value={element.softness} onChange={(value) => updateElement(element.id, { softness: Math.min(1, Math.max(0, value)) })} />
            <NumberField label="方向" value={element.direction} step={1} onChange={(value) => updateElement(element.id, { direction: value })} />
            <NumberField label="范围" value={element.range} onChange={(value) => updateElement(element.id, { range: Math.min(4, Math.max(0.01, value)) })} />
          </div>
        </div>
      )}
      {element.type === 'shape' && showSection('形状 填充 形态 描边 圆角 shape fill stroke corner') && (
        <div className="inspector-section">
          <p className="section-kicker">形状</p>
          <label className="color-field"><span>填充</span><input type="color" value={element.fill} onChange={(event) => updateElement(element.id, { fill: event.currentTarget.value })} /></label>
          <label className="wide-field"><span>形态</span><select value={element.shape} onChange={(event) => updateElement(element.id, { shape: event.currentTarget.value })}><option value="rectangle">矩形</option><option value="ellipse">椭圆</option><option value="line">线条</option></select></label>
          <label className="checkbox-field"><input type="checkbox" checked={element.stroke !== null} onChange={(event) => updateElement(element.id, { stroke: event.currentTarget.checked ? '#7890AA' : null })} /><span>启用描边</span></label>
          {element.stroke !== null && <><label className="color-field"><span>描边</span><input type="color" value={element.stroke} onChange={(event) => updateElement(element.id, { stroke: event.currentTarget.value })} /></label><NumberField label="描边比例" value={element.strokeWidth} onChange={(value) => updateElement(element.id, { strokeWidth: Math.min(1, Math.max(0, value)) })} /></>}
          {element.shape === 'rectangle' && <NumberField label="圆角比例" value={element.cornerRadius} onChange={(value) => updateElement(element.id, { cornerRadius: Math.min(0.5, Math.max(0, value)) })} />}
        </div>
      )}
      {element.type === 'image' && showSection('图片 适配 参考角色 裁切 image fit reference crop') && (
        <div className="inspector-section">
          <p className="section-kicker">图片</p>
          <label className="wide-field"><span>适配</span><select value={element.fit} onChange={(event) => updateElement(element.id, { fit: event.currentTarget.value })}><option value="contain">完整显示</option><option value="cover">填满裁切</option><option value="fill">自由拉伸</option></select></label>
          <label className="wide-field"><span>参考角色</span><select value={element.referenceRole} onChange={(event) => updateElement(element.id, { referenceRole: event.currentTarget.value })}><option value="general">普通元素</option><option value="subject">主体参考</option><option value="style">风格参考</option><option value="composition">构图参考</option><option value="color">色彩参考</option><option value="material">材质参考</option></select></label>
          <p className="field-note">双击画布图片会打开此属性入口；裁切框将在后续高级编辑中继续扩展。</p>
        </div>
      )}
      {element.type === 'sketch' && showSection('草图 参考强度 最终导出 sketch fidelity visible') && (
        <div className="inspector-section">
          <p className="section-kicker">草图参考</p>
          <NumberField label="参考强度" value={element.fidelity} onChange={(value) => updateElement(element.id, { fidelity: Math.min(1, Math.max(0, value)) })} />
          <label className="checkbox-field"><input type="checkbox" checked={element.finalVisible} onChange={(event) => updateElement(element.id, { finalVisible: event.currentTarget.checked })} /><span>在最终导出中保留</span></label>
        </div>
      )}
      {element.type === 'mask' && showSection('蒙版 区域类型 羽化 修改 保护 生成 mask feather edit protect generate') && (
        <div className="inspector-section">
          <p className="section-kicker">蒙版语义</p>
          <label className="wide-field"><span>区域类型</span><select value={element.mode} onChange={(event) => updateElement(element.id, { mode: event.currentTarget.value })}><option value="edit">修改区</option><option value="protect">保护区</option><option value="generate">生成区</option></select></label>
          <NumberField label="羽化" value={element.feather} onChange={(value) => updateElement(element.id, { feather: Math.min(1, Math.max(0, value)) })} />
        </div>
      )}
    </>
  )
}

export function Inspector({ onRequestCollapse, projection = 'vertical' }: { readonly onRequestCollapse?: () => void; readonly projection?: 'vertical' | 'horizontal' } = {}): React.JSX.Element {
  const scene = useWorkspaceStore((state) => state.scene)
  const selectedIds = useWorkspaceStore((state) => state.selectedIds)
  const editingGroupId = useWorkspaceStore((state) => state.editingGroupId)
  const tab = useWorkspaceStore((state) => state.inspectorTab)
  const select = useWorkspaceStore((state) => state.select)
  const setTab = useWorkspaceStore((state) => state.setInspectorTab)
  const setOpen = useWorkspaceStore((state) => state.setInspectorOpen)
  const updateElement = useWorkspaceStore((state) => state.updateElement)
  const reorder = useWorkspaceStore((state) => state.reorderElement)
  const align = useWorkspaceStore((state) => state.alignSelection)
  const distribute = useWorkspaceStore((state) => state.distributeSelection)
  const group = useWorkspaceStore((state) => state.groupSelection)
  const ungroup = useWorkspaceStore((state) => state.ungroupSelection)
  const enterGroupEditing = useWorkspaceStore((state) => state.enterGroupEditing)
  const duplicateSelection = useWorkspaceStore((state) => state.duplicateSelection)
  const deleteSelection = useWorkspaceStore((state) => state.deleteSelection)
  const [propertyMode, setPropertyMode] = useState<'simple' | 'advanced'>('simple')
  const selected = scene.elements.find((element) => element.id === selectedIds[0])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [propertySearch, setPropertySearch] = useState('')
  const horizontal = projection === 'horizontal'

  useEffect(() => {
    const id = selectedIds[0]
    if (id === undefined) return
    const row = document.querySelector(`[data-layer-id="${id}"]`)
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [selectedIds])

  const finishRename = (element: SceneElement, value = editingName): void => {
    const name = value.trim()
    if (name !== '' && name !== element.name) updateElement(element.id, { name }, '重命名图层')
    setEditingId(null)
  }

  const actOn = (id: string, action: 'duplicate' | 'delete' | 'front' | 'back'): void => {
    select(id, false)
    if (action === 'duplicate') duplicateSelection()
    else if (action === 'delete') deleteSelection()
    else reorder(id, action === 'front' ? scene.elements.length - 1 : 0)
  }

  const renderLayer = (element: SceneElement, depth = 0): React.JSX.Element => {
    const isGroup = element.type === 'group'
    const collapsed = isGroup && collapsedGroups.has(element.id)
    const maskChildren = scene.elements.filter((candidate) => candidate.type === 'mask' && candidate.targetElementId === element.id)
    const groupChildren = isGroup
      ? element.childIds.map((id) => scene.elements.find((candidate) => candidate.id === id)).filter((candidate): candidate is SceneElement => candidate !== undefined).sort((a, b) => b.zIndex - a.zIndex)
      : []
    return (
      <div key={element.id} className="layer-tree-node">
        <div
          role="option"
          aria-selected={selectedIds.includes(element.id)}
          data-layer-id={element.id}
          draggable={!element.locked}
          className={`layer-row${selectedIds.includes(element.id) ? ' is-selected' : ''}${editingGroupId === element.id ? ' is-editing-group' : ''}${draggedId === element.id ? ' is-dragging' : ''}`}
          style={{ '--layer-depth': depth } as React.CSSProperties}
          onClick={(event) => select(element.id, event.shiftKey || event.ctrlKey)}
          onDoubleClick={() => {
            if (isGroup) enterGroupEditing(element.id)
            else { setEditingId(element.id); setEditingName(element.name) }
          }}
          onDragStart={(event) => { setDraggedId(element.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', element.id) }}
          onDragEnd={() => setDraggedId(null)}
          onDragOver={(event) => { if (draggedId !== null && draggedId !== element.id) event.preventDefault() }}
          onDrop={(event) => { event.preventDefault(); if (draggedId !== null && draggedId !== element.id) reorder(draggedId, element.zIndex); setDraggedId(null) }}
        >
          <span className="layer-drag" aria-hidden="true"><GripVertical size={13} /></span>
          {isGroup ? <button type="button" className={`layer-disclosure${collapsed ? '' : ' is-open'}`} aria-label={collapsed ? `展开${element.name}` : `折叠${element.name}`} onClick={(event) => { event.stopPropagation(); setCollapsedGroups((current) => { const next = new Set(current); if (next.has(element.id)) next.delete(element.id); else next.add(element.id); return next }) }}><ChevronRight size={13} /></button> : <span className="layer-disclosure-spacer" />}
          <span className={`layer-kind kind-${element.type}`}>{elementLabels[element.type].slice(0, 1)}</span>
          <span className="layer-copy">
            {editingId === element.id
              ? <ImeSafeInput aria-label={`重命名${element.name}`} autoFocus value={editingName} commitDelayMs={null} commitOnEnter onCommit={(value) => finishRename(element, value)} onEscape={() => setEditingId(null)} onClick={(event) => event.stopPropagation()} />
              : <strong>{element.name}</strong>}
            <small>{elementLabels[element.type]}{element.type === 'mask' ? ' · 归属目标' : element.referencePolicy === 'reference-only' ? ' · 仅参考' : ''}{resolveBlendMode(element) !== 'normal' ? ` · ${blendModeLabel(resolveBlendMode(element))}` : ''}</small>
          </span>
          <span className="layer-actions">
            <button type="button" title="复制" aria-label={`复制${element.name}`} onClick={(event) => { event.stopPropagation(); actOn(element.id, 'duplicate') }}><Copy size={12} /></button>
            <button type="button" title="删除" aria-label={`删除${element.name}`} onClick={(event) => { event.stopPropagation(); actOn(element.id, 'delete') }}><Trash2 size={12} /></button>
            <button type="button" aria-label={element.visible ? `隐藏${element.name}` : `显示${element.name}`} disabled={element.locked} onClick={(event) => { event.stopPropagation(); updateElement(element.id, { visible: !element.visible }, element.visible ? '隐藏图层' : '显示图层') }}>{element.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
            <button type="button" aria-label={element.locked ? `解锁${element.name}` : `锁定${element.name}`} onClick={(event) => { event.stopPropagation(); updateElement(element.id, { locked: !element.locked }, element.locked ? '解锁图层' : '锁定图层') }}>{element.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
          </span>
          <span className="layer-order">
            <button type="button" title="置顶" aria-label={`置顶${element.name}`} onClick={(event) => { event.stopPropagation(); actOn(element.id, 'front') }}><ChevronsUp size={11} /></button>
            <button type="button" aria-label={`上移${element.name}`} onClick={(event) => { event.stopPropagation(); reorder(element.id, Math.min(scene.elements.length - 1, element.zIndex + 1)) }}><ArrowUp size={11} /></button>
            <button type="button" aria-label={`下移${element.name}`} onClick={(event) => { event.stopPropagation(); reorder(element.id, Math.max(0, element.zIndex - 1)) }}><ArrowDown size={11} /></button>
            <button type="button" title="置底" aria-label={`置底${element.name}`} onClick={(event) => { event.stopPropagation(); actOn(element.id, 'back') }}><ChevronsDown size={11} /></button>
          </span>
        </div>
        {!collapsed && groupChildren.map((child) => renderLayer(child, depth + 1))}
        {maskChildren.map((mask) => renderLayer(mask, depth + 1))}
      </div>
    )
  }

  const layerRoots = [...scene.elements]
    .filter((element) => element.groupId === null && !(element.type === 'mask' && scene.elements.some((candidate) => candidate.id === element.targetElementId)))
    .sort((a, b) => b.zIndex - a.zIndex)

  const selectedTypeLabel = selected === undefined ? '画布' : elementLabels[selected.type]
  const properties = useMemo(() => selected === undefined ? [] : simplePropertiesFor(selected), [selected])

  return (
    <aside className={`inspector projection-${projection}`} aria-label="检查器" data-inspector-projection={projection}>
      <div className="inspector-header">
        <div className="inspector-tabs" role="tablist" aria-label="检查器内容">
          <button type="button" role="tab" aria-selected={tab === 'layers'} className={tab === 'layers' ? 'is-active' : ''} onClick={() => setTab('layers')}><Rows3 size={15} />图层</button>
          <button type="button" role="tab" aria-selected={tab === 'properties'} className={tab === 'properties' ? 'is-active' : ''} onClick={() => setTab('properties')}><SlidersHorizontal size={15} />属性</button>
        </div>
        {tab === 'properties' && (
          <div className="property-mode-toggle" role="group" aria-label="属性复杂度">
            <button type="button" className={propertyMode === 'simple' ? 'is-active' : ''} aria-pressed={propertyMode === 'simple'} onClick={() => setPropertyMode('simple')}>简易</button>
            <button type="button" className={propertyMode === 'advanced' ? 'is-active' : ''} aria-pressed={propertyMode === 'advanced'} onClick={() => setPropertyMode('advanced')}>高级</button>
          </div>
        )}
        <button type="button" className="icon-button quiet" aria-label="收起检查器" onClick={() => { if (onRequestCollapse === undefined) setOpen(false); else onRequestCollapse() }}><PanelRightClose size={17} /></button>
      </div>

      {tab === 'layers' ? (
        <div className="layers-panel">
          <div className="arrange-strip" aria-label="排列工具">
            <button type="button" title="左对齐" aria-label="左对齐" onClick={() => align('left')}><AlignStartVertical size={15} /></button>
            <button type="button" title="水平居中" aria-label="水平居中" onClick={() => align('center-x')}><AlignCenterVertical size={15} /></button>
            <button type="button" title="右对齐" aria-label="右对齐" onClick={() => align('right')}><AlignEndVertical size={15} /></button>
            <button type="button" title="顶对齐" aria-label="顶对齐" onClick={() => align('top')}><AlignStartHorizontal size={15} /></button>
            <button type="button" title="垂直居中" aria-label="垂直居中" onClick={() => align('center-y')}><AlignCenterHorizontal size={15} /></button>
            <button type="button" title="底对齐" aria-label="底对齐" onClick={() => align('bottom')}><AlignEndHorizontal size={15} /></button>
            <span />
            <button type="button" title="组合" aria-label="组合" onClick={group}><GroupIcon size={15} /></button>
            <button type="button" title="取消组合" aria-label="取消组合" onClick={ungroup}><Ungroup size={15} /></button>
          </div>
          <div className="layer-list" role="listbox" aria-label="图层">
            {layerRoots.map((element) => renderLayer(element))}
          </div>
          {selectedIds.length >= 3 && <div className="distribution-actions" aria-label="分布工具">
            <button type="button" className="text-action" onClick={() => distribute('horizontal')}>水平等距分布</button>
            <button type="button" className="text-action" onClick={() => distribute('vertical')}>垂直等距分布</button>
          </div>}
        </div>
      ) : (
        <div className={`properties-panel mode-${propertyMode}${selected === undefined ? ' type-canvas' : ` type-${selected.type}`}`} data-simple-field-count={properties.length}>
          {selected === undefined
            ? <CanvasProperties canvas={scene.canvas} />
            : propertyMode === 'simple'
              ? <><div className="simple-property-title"><span>{selectedTypeLabel}</span><strong>{selected.name}</strong><small>{properties.length} 个常用属性</small></div><SimpleElementProperties element={selected} canvas={scene.canvas} horizontal={horizontal} /></>
              : <>
                  <label className="property-search"><Search size={13} /><span className="visually-hidden">搜索高级属性</span><input aria-label="搜索高级属性" value={propertySearch} placeholder="搜索属性…" onChange={(event) => setPropertySearch(event.currentTarget.value)} /></label>
                  <ElementProperties element={selected} canvas={scene.canvas} search={propertySearch} />
                </>}
        </div>
      )}
    </aside>
  )
}
