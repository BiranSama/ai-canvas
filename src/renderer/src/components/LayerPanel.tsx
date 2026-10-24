import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Box,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Group as GroupIcon,
  Image as ImageIcon,
  Lock,
  MoreHorizontal,
  PenLine,
  Search,
  SquareDashed,
  Sun,
  Trash2,
  Ungroup
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { pathInBox, type SceneElement } from '../../../domain'
import { BLEND_MODES, blendModeLabel, elementSupportsBlendMode, resolveBlendMode } from '../../../shared/blend-mode'
import { getRuntimeAssetUrl, getRuntimeAssetVersion, subscribeRuntimeAssets } from '../assets/runtime-assets'
import { useWorkspaceStore } from '../store/workspace-store'
import { ImeSafeInput } from './ImeSafeTextField'

const KIND_LABELS: Record<SceneElement['type'], string> = {
  image: '图片', text: '文字', sketch: '草图', shape: '形状', placeholder: '主体', light: '光影', mask: '蒙版', group: '组合'
}

interface Row {
  readonly element: SceneElement
  readonly depth: number
}

interface MenuState {
  readonly id: string
  readonly x: number
  readonly y: number
}

interface DropTarget {
  readonly id: string
  readonly after: boolean
}

function luminance(hex: string): number {
  const value = /^#?([\da-f]{6})/i.exec(hex)?.[1]
  if (value === undefined) return 0.5
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** A small picture of the layer: the image itself, the shape in its colours, the first character of text. */
function LayerThumb({ element, open }: { readonly element: SceneElement; readonly open: boolean }): React.JSX.Element {
  useSyncExternalStore(subscribeRuntimeAssets, getRuntimeAssetVersion, getRuntimeAssetVersion)
  if (element.type === 'image') {
    const url = getRuntimeAssetUrl(element.assetId)
    return <span className="layer-thumb is-image">{url === null ? <ImageIcon size={14} /> : <img src={url} alt="" draggable={false} />}</span>
  }
  if (element.type === 'shape') {
    const fill = element.fill
    const stroke = element.stroke ?? (element.shape === 'line' ? fill : 'none')
    const box = { x: 4, y: 4, w: 20, h: 20 }
    const ratio = element.transform.width / Math.max(0.0001, element.transform.height)
    const w = ratio >= 1 ? box.w : box.w * ratio
    const h = ratio >= 1 ? box.h / ratio : box.h
    const x = box.x + (box.w - w) / 2
    const y = box.y + (box.h - h) / 2
    return (
      <span className="layer-thumb is-shape">
        <svg viewBox="0 0 28 28" aria-hidden="true">
          {element.shape === 'ellipse' && <ellipse cx={14} cy={14} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={1} />}
          {element.shape === 'line' && <line x1={4} y1={14} x2={24} y2={14} stroke={stroke} strokeWidth={2} strokeLinecap="round" />}
          {element.shape === 'rectangle' && <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) * element.cornerRadius} fill={fill} stroke={stroke} strokeWidth={1} />}
          {element.shape === 'path' && element.path !== undefined && <path d={pathInBox(element.path, w, h, x, y)} fill={fill} stroke={stroke === 'none' ? 'none' : stroke} strokeWidth={1} />}
        </svg>
      </span>
    )
  }
  if (element.type === 'text') {
    const glyph = [...element.content.trim()][0] ?? 'T'
    return (
      <span className="layer-thumb is-text" style={{ color: element.fill, fontFamily: `"${element.fontFamily}", sans-serif`, background: luminance(element.fill) > 0.6 ? '#3B3F46' : '#F4F5F7' }}>
        {glyph}
      </span>
    )
  }
  if (element.type === 'light') return <span className="layer-thumb is-icon"><Sun size={14} color={element.color} /></span>
  if (element.type === 'mask') return <span className={`layer-thumb is-icon is-mask-${element.mode}`}><SquareDashed size={14} /></span>
  if (element.type === 'sketch') return <span className="layer-thumb is-icon"><PenLine size={14} /></span>
  if (element.type === 'placeholder') return <span className="layer-thumb is-icon is-placeholder"><Box size={14} /></span>
  return <span className="layer-thumb is-icon is-group">{open ? <FolderOpen size={15} /> : <Folder size={15} />}</span>
}

function childrenOf(elements: readonly SceneElement[], element: SceneElement): readonly SceneElement[] {
  const ids = element.type === 'group' ? element.childIds : []
  const masks = elements.filter((candidate) => candidate.type === 'mask' && candidate.targetElementId === element.id)
  return [...elements.filter((candidate) => ids.includes(candidate.id)), ...masks].sort((left, right) => right.zIndex - left.zIndex)
}

/**
 * Layers as in Photoshop: top of the stack first, a visibility eye and lock
 * on every row, thumbnails, indented groups that fold, blend mode and
 * opacity for the selection on top, and actions at the bottom and on a
 * right click. Rows reorder by dragging, with a line where they will land.
 */
export function LayerPanel(): React.JSX.Element {
  const scene = useWorkspaceStore((state) => state.scene)
  const selectedIds = useWorkspaceStore((state) => state.selectedIds)
  const editingGroupId = useWorkspaceStore((state) => state.editingGroupId)
  const select = useWorkspaceStore((state) => state.select)
  const setSelection = useWorkspaceStore((state) => state.setSelection)
  const execute = useWorkspaceStore((state) => state.execute)
  const updateElement = useWorkspaceStore((state) => state.updateElement)
  const reorder = useWorkspaceStore((state) => state.reorderElement)
  const align = useWorkspaceStore((state) => state.alignSelection)
  const distribute = useWorkspaceStore((state) => state.distributeSelection)
  const group = useWorkspaceStore((state) => state.groupSelection)
  const ungroup = useWorkspaceStore((state) => state.ungroupSelection)
  const enterGroupEditing = useWorkspaceStore((state) => state.enterGroupEditing)
  const duplicateSelection = useWorkspaceStore((state) => state.duplicateSelection)
  const deleteSelection = useWorkspaceStore((state) => state.deleteSelection)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [filter, setFilter] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  // Alt+click on an eye shows only that layer; the visibility before it, to restore on the next Alt+click.
  const [solo, setSolo] = useState<{ readonly id: string; readonly before: ReadonlyMap<string, boolean> } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const elements = scene.elements
  const byId = useMemo(() => new Map(elements.map((element) => [element.id, element])), [elements])
  const rows = useMemo((): readonly Row[] => {
    const query = filter.trim().toLowerCase()
    const matches = (element: SceneElement): boolean => query === '' || element.name.toLowerCase().includes(query)
      || childrenOf(elements, element).some(matches)
    const result: Row[] = []
    const walk = (element: SceneElement, depth: number): void => {
      if (!matches(element)) return
      result.push({ element, depth })
      if (query === '' && collapsed.has(element.id)) return
      for (const child of childrenOf(elements, element)) walk(child, depth + 1)
    }
    elements
      .filter((element) => element.groupId === null && !(element.type === 'mask' && byId.has(element.targetElementId)))
      .sort((left, right) => right.zIndex - left.zIndex)
      .forEach((element) => walk(element, 0))
    return result
  }, [byId, collapsed, elements, filter])

  const selected = selectedIds.map((id) => byId.get(id)).filter((element): element is SceneElement => element !== undefined)
  const blendable = selected.filter((element) => elementSupportsBlendMode(element.type))
  const sharedBlend = blendable.length > 0 && blendable.every((element) => resolveBlendMode(element) === resolveBlendMode(blendable[0]!)) ? resolveBlendMode(blendable[0]!) : null
  const sharedOpacity = selected.length > 0 && selected.every((element) => element.opacity === selected[0]!.opacity) ? selected[0]!.opacity : null

  useEffect(() => {
    const id = selectedIds[0]
    if (id === undefined) return
    const row = listRef.current?.querySelector(`[data-layer-id="${id}"]`)
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [selectedIds])

  useEffect(() => {
    if (menu === null) return
    const close = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const escape = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [menu])

  const updateSelected = (changes: Record<string, unknown>, summary: string, only: readonly SceneElement[] = selected): void => {
    if (only.length === 0) return
    void execute(summary, only.map((element) => ({ kind: 'element.update' as const, elementId: element.id, changes })))
  }

  const toggleCollapsed = (id: string): void => setCollapsed((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  /** Click selects, Ctrl or ⌘ adds or removes, Shift selects the rows between the last click and this one. */
  const choose = (event: ReactMouseEvent | KeyboardEvent, id: string): void => {
    if (event.shiftKey && anchor !== null) {
      const from = rows.findIndex((row) => row.element.id === anchor)
      const to = rows.findIndex((row) => row.element.id === id)
      if (from !== -1 && to !== -1) {
        setSelection(rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((row) => row.element.id))
        return
      }
    }
    select(id, event.ctrlKey || event.metaKey)
    setAnchor(id)
  }

  const finishRename = (element: SceneElement, value: string): void => {
    const name = value.trim()
    if (name !== '' && name !== element.name) void updateElement(element.id, { name }, '重命名图层')
    setRenaming(null)
  }

  const act = (id: string, action: 'duplicate' | 'delete' | 'front' | 'forward' | 'backward' | 'back' | 'rename' | 'visibility' | 'lock' | 'group' | 'ungroup'): void => {
    setMenu(null)
    const element = byId.get(id)
    if (element === undefined) return
    if (!selectedIds.includes(id)) select(id, false)
    if (action === 'duplicate') void duplicateSelection()
    else if (action === 'delete') void deleteSelection()
    else if (action === 'front') void reorder(id, elements.length - 1)
    else if (action === 'forward') void reorder(id, Math.min(elements.length - 1, element.zIndex + 1))
    else if (action === 'backward') void reorder(id, Math.max(0, element.zIndex - 1))
    else if (action === 'back') void reorder(id, 0)
    else if (action === 'rename') setRenaming(id)
    else if (action === 'visibility') void updateElement(id, { visible: !element.visible }, element.visible ? '隐藏图层' : '显示图层')
    else if (action === 'lock') void updateElement(id, { locked: !element.locked }, element.locked ? '解锁图层' : '锁定图层')
    else if (action === 'group') void group()
    else void ungroup()
  }

  /** Photoshop's Alt+click on an eye: only this layer (with its group and contents) stays visible; again restores the rest. */
  const toggleSolo = (element: SceneElement): void => {
    if (solo !== null && solo.id === element.id) {
      const commands = elements.flatMap((candidate) => {
        const before = solo.before.get(candidate.id)
        return before === undefined || before === candidate.visible || candidate.locked ? [] : [{ kind: 'element.update' as const, elementId: candidate.id, changes: { visible: before } }]
      })
      setSolo(null)
      if (commands.length > 0) void execute('恢复图层显示', commands)
      return
    }
    const keep = new Set<string>([element.id])
    const addContents = (id: string): void => {
      const current = byId.get(id)
      for (const child of current === undefined ? [] : childrenOf(elements, current)) { keep.add(child.id); addContents(child.id) }
    }
    addContents(element.id)
    for (let parent = element.groupId; parent !== null; parent = byId.get(parent)?.groupId ?? null) keep.add(parent)
    const commands = elements.flatMap((candidate) => {
      const visible = keep.has(candidate.id)
      return candidate.visible === visible || candidate.locked ? [] : [{ kind: 'element.update' as const, elementId: candidate.id, changes: { visible } }]
    })
    setSolo({ id: element.id, before: new Map(elements.map((candidate) => [candidate.id, candidate.visible])) })
    if (commands.length > 0) void execute(`只显示“${element.name}”`, commands)
  }

  const onListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (renaming !== null || event.nativeEvent.isComposing || event.target instanceof HTMLInputElement) return
    const current = rows.findIndex((row) => row.element.id === selectedIds[selectedIds.length - 1])
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (next !== undefined) choose(event, next.element.id)
    } else if (event.key === 'F2' && current !== -1) {
      event.preventDefault()
      setRenaming(rows[current]!.element.id)
    } else if (event.key === 'Enter' && current !== -1) {
      // Enter works like a double click: into a group, or rename anything else.
      event.preventDefault()
      const element = rows[current]!.element
      if (element.type === 'group') enterGroupEditing(element.id)
      else setRenaming(element.id)
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length > 0) {
      event.preventDefault()
      void deleteSelection()
    }
  }

  const dropAt = (event: React.DragEvent<HTMLElement>, element: SceneElement): DropTarget => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { id: element.id, after: event.clientY > rect.top + rect.height / 2 }
  }

  /** The list runs top to bottom, so "after" a row is beneath it in the stack. */
  const finishDrop = (target: DropTarget): void => {
    const moving = dragged === null ? undefined : byId.get(dragged)
    const onto = byId.get(target.id)
    setDragged(null)
    setDrop(null)
    if (moving === undefined || onto === undefined || moving.id === onto.id) return
    const above = target.after ? onto.zIndex : onto.zIndex + 1
    void reorder(moving.id, moving.zIndex < above ? above - 1 : above)
  }

  const menuElement = menu === null ? undefined : byId.get(menu.id)

  return (
    <div className="layers-panel">
      <div className="layer-options" aria-label="所选图层">
        <select aria-label="混合模式" value={sharedBlend ?? ''} disabled={blendable.length === 0}
          onChange={(event) => updateSelected({ blendMode: event.currentTarget.value }, '调整混合模式', blendable)}>
          {sharedBlend === null && <option value="" disabled>{blendable.length === 0 ? '混合模式' : '多种'}</option>}
          {BLEND_MODES.map((mode) => <option key={mode} value={mode}>{blendModeLabel(mode)}</option>)}
        </select>
        <label className="layer-opacity">
          <span>不透明度</span>
          <input aria-label="不透明度" type="range" min={0} max={1} step={0.01} disabled={selected.length === 0} value={sharedOpacity ?? 1}
            onChange={(event) => updateSelected({ opacity: Number(event.currentTarget.value) }, '调整不透明度')} />
          <output>{selected.length === 0 ? '—' : sharedOpacity === null ? '多种' : `${Math.round(sharedOpacity * 100)}%`}</output>
        </label>
      </div>
      <label className="layer-filter">
        <Search size={13} aria-hidden="true" />
        <input aria-label="筛选图层" placeholder="筛选图层" value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
      </label>

      <div className="layer-list" role="listbox" aria-label="图层" aria-multiselectable="true" tabIndex={0} ref={listRef} onKeyDown={onListKey}>
        {rows.length === 0 && <p className="layer-empty">{filter.trim() === '' ? '画布上还没有图层。' : '没有名字匹配的图层。'}</p>}
        {rows.map(({ element, depth }) => {
          const isGroup = element.type === 'group'
          const open = isGroup && !collapsed.has(element.id)
          const isSelected = selectedIds.includes(element.id)
          const blend = resolveBlendMode(element)
          const meta = [
            ...(blend === 'normal' ? [] : [blendModeLabel(blend)]),
            ...(element.opacity < 1 ? [`${Math.round(element.opacity * 100)}%`] : []),
            ...(element.referencePolicy === 'reference-only' ? ['仅参考'] : [])
          ]
          const dropping = drop?.id === element.id
          return (
            <div
              key={element.id}
              role="option"
              aria-selected={isSelected}
              data-layer-id={element.id}
              draggable={renaming !== element.id}
              className={`layer-row${isSelected ? ' is-selected' : ''}${element.visible ? '' : ' is-hidden'}${editingGroupId === element.id ? ' is-editing-group' : ''}${dragged === element.id ? ' is-dragging' : ''}${dropping ? drop!.after ? ' drop-after' : ' drop-before' : ''}`}
              style={{ '--layer-depth': depth } as React.CSSProperties}
              onClick={(event) => {
                choose(event, element.id)
                // A pointer pick hands the keyboard back to the canvas, so arrows
                // nudge and Delete removes, as in Photoshop. Tabbing into the list
                // still gives row-by-row keyboard navigation.
                if (document.activeElement === listRef.current) listRef.current?.blur()
              }}
              onDoubleClick={() => { if (isGroup) enterGroupEditing(element.id); else setRenaming(element.id) }}
              onContextMenu={(event) => {
                event.preventDefault()
                if (!isSelected) { select(element.id, false); setAnchor(element.id) }
                setMenu({ id: element.id, x: event.clientX, y: event.clientY })
              }}
              onDragStart={(event) => { setDragged(element.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', element.id) }}
              onDragEnd={() => { setDragged(null); setDrop(null) }}
              onDragOver={(event) => {
                if (dragged === null || dragged === element.id) return
                event.preventDefault()
                setDrop(dropAt(event, element))
              }}
              onDrop={(event) => { event.preventDefault(); finishDrop(dropAt(event, element)) }}
            >
              <button type="button" className={`layer-eye${element.visible ? '' : ' is-off'}`} aria-label={element.visible ? `隐藏${element.name}` : `显示${element.name}`} title={element.visible ? '隐藏' : '显示'}
                disabled={element.locked} onClick={(event) => { event.stopPropagation(); if (event.altKey) toggleSolo(element); else act(element.id, 'visibility') }}>
                {element.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <span className="layer-indent" aria-hidden="true" />
              {isGroup
                ? <button type="button" className={`layer-disclosure${open ? ' is-open' : ''}`} aria-label={open ? `折叠${element.name}` : `展开${element.name}`} onClick={(event) => { event.stopPropagation(); toggleCollapsed(element.id) }}><ChevronRight size={13} /></button>
                : <span className="layer-disclosure-spacer" aria-hidden="true" />}
              <LayerThumb element={element} open={open} />
              <span className="layer-copy" title={`${element.name} · ${KIND_LABELS[element.type]}`}>
                {renaming === element.id
                  ? <ImeSafeInput aria-label={`重命名${element.name}`} autoFocus value={element.name} commitDelayMs={null} commitOnEnter onCommit={(value) => finishRename(element, value)} onEscape={() => setRenaming(null)} onClick={(event) => event.stopPropagation()} />
                  : <strong>{element.name}</strong>}
                {meta.length > 0 && <small>{meta.join(' · ')}</small>}
              </span>
              {element.locked
                ? <button type="button" className="layer-lock is-on" aria-label={`解锁${element.name}`} title="解锁" onClick={(event) => { event.stopPropagation(); act(element.id, 'lock') }}><Lock size={12} /></button>
                : <button type="button" className="layer-lock" aria-label={`锁定${element.name}`} title="锁定" onClick={(event) => { event.stopPropagation(); act(element.id, 'lock') }}><Lock size={12} /></button>}
              <button type="button" className="layer-more" aria-label={`更多操作 ${element.name}`} title="更多" onClick={(event) => {
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                if (!isSelected) { select(element.id, false); setAnchor(element.id) }
                setMenu({ id: element.id, x: rect.right, y: rect.bottom })
              }}><MoreHorizontal size={14} /></button>
            </div>
          )
        })}
      </div>

      <div className="layer-footer" role="toolbar" aria-label="图层操作">
        <div className="layer-align" role="group" aria-label="排列工具">
          <button type="button" title="左对齐" aria-label="左对齐" disabled={selected.length === 0} onClick={() => void align('left')}><AlignStartVertical size={14} /></button>
          <button type="button" title="水平居中" aria-label="水平居中" disabled={selected.length === 0} onClick={() => void align('center-x')}><AlignCenterVertical size={14} /></button>
          <button type="button" title="右对齐" aria-label="右对齐" disabled={selected.length === 0} onClick={() => void align('right')}><AlignEndVertical size={14} /></button>
          <button type="button" title="顶对齐" aria-label="顶对齐" disabled={selected.length === 0} onClick={() => void align('top')}><AlignStartHorizontal size={14} /></button>
          <button type="button" title="垂直居中" aria-label="垂直居中" disabled={selected.length === 0} onClick={() => void align('center-y')}><AlignCenterHorizontal size={14} /></button>
          <button type="button" title="底对齐" aria-label="底对齐" disabled={selected.length === 0} onClick={() => void align('bottom')}><AlignEndHorizontal size={14} /></button>
        </div>
        <div className="layer-actions" role="group" aria-label="图层">
          <button type="button" title="组合所选" aria-label="组合" disabled={selected.length < 2} onClick={() => void group()}><GroupIcon size={14} /></button>
          <button type="button" title="取消组合" aria-label="取消组合" disabled={!selected.some((element) => element.type === 'group')} onClick={() => void ungroup()}><Ungroup size={14} /></button>
          <button type="button" title="复制所选" aria-label="复制所选" disabled={selected.length === 0} onClick={() => void duplicateSelection()}><Copy size={14} /></button>
          <button type="button" title="删除所选" aria-label="删除所选" disabled={selected.length === 0} onClick={() => void deleteSelection()}><Trash2 size={14} /></button>
        </div>
      </div>
      {selected.length >= 3 && <div className="distribution-actions" aria-label="分布工具">
        <button type="button" className="text-action" onClick={() => void distribute('horizontal')}>水平等距分布</button>
        <button type="button" className="text-action" onClick={() => void distribute('vertical')}>垂直等距分布</button>
      </div>}

      {/* The island's backdrop filter would make it the containing block of a fixed menu, so the menu lives on the body. */}
      {menu !== null && menuElement !== undefined && createPortal(
        <div className="layer-menu" role="menu" aria-label={`${menuElement.name} 的操作`} ref={menuRef} style={{ left: Math.min(menu.x, window.innerWidth - 196), top: Math.min(menu.y, window.innerHeight - 340) }}>
          <button type="button" role="menuitem" onClick={() => act(menu.id, 'rename')}>重命名<kbd>F2</kbd></button>
          <button type="button" role="menuitem" onClick={() => act(menu.id, 'duplicate')}>复制</button>
          <button type="button" role="menuitem" onClick={() => act(menu.id, 'visibility')} disabled={menuElement.locked}>{menuElement.visible ? '隐藏' : '显示'}</button>
          <button type="button" role="menuitem" onClick={() => act(menu.id, 'lock')}>{menuElement.locked ? '解锁' : '锁定'}</button>
          <hr />
          <button type="button" role="menuitem" onClick={() => act(menu.id, 'front')}>置于顶层</button>
          <button type="button" role="menuitem" onClick={() => act(menu.id, 'forward')}>上移一层</button>
          <button type="button" role="menuitem" onClick={() => act(menu.id, 'backward')}>下移一层</button>
          <button type="button" role="menuitem" onClick={() => act(menu.id, 'back')}>置于底层</button>
          <hr />
          <button type="button" role="menuitem" onClick={() => act(menu.id, 'group')} disabled={selected.length < 2}>组合所选</button>
          {menuElement.type === 'group' && <button type="button" role="menuitem" onClick={() => act(menu.id, 'ungroup')}>取消组合</button>}
          <button type="button" role="menuitem" className="is-danger" onClick={() => act(menu.id, 'delete')}>删除</button>
        </div>,
        document.body
      )}
    </div>
  )
}
