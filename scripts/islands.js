// Glass Islands playground — a faithful re-implementation of the product's island
// behaviour contract: drag only from the grip, dock to four edges with a preview,
// horizontal projection when docked top/bottom, resize, collapse to an orb that
// names what it restores, keyboard access, persistence, reliable pointer release.
(() => {
const STORAGE_KEY = 'ai-canvas-site-islands-v1'
const EDGE = 30
const MARGIN = 8
const MIN_W = 56
const MIN_H = 80

const ICONS = { toolbar: '#i-pointer', inspector: '#i-layers', composer: '#i-arrow-up' }
const NAMES = { toolbar: '工具', inspector: '检查器', composer: '创作输入' }

function defaultsFor(id, bounds) {
  const { width: W, height: H } = bounds
  if (W < 600) {
    // Keep the artwork visible on the presentation's small screens. Restore
    // still opens the real instrument and every tool remains reachable.
    if (id === 'toolbar') return { mode: 'docked-top', x: 8, y: 16, w: null, h: null }
    if (id === 'inspector') return { mode: 'orb', lastMode: 'floating', x: 24, y: 120, w: Math.min(268, W - 32), h: null }
    if (id === 'composer') return { mode: 'orb', lastMode: 'floating', x: 16, y: Math.max(160, H - 156), w: W - 32, h: null }
  }
  switch (id) {
    case 'toolbar': return { mode: 'floating', x: 24, y: 120, w: null, h: null }
    case 'inspector': return { mode: 'floating', x: Math.max(24, W - 300), y: 96, w: 268, h: null }
    case 'composer': return { mode: 'floating', x: Math.max(16, (W - 500) / 2), y: Math.max(160, H - 132), w: Math.min(500, W - 32), h: null }
    default: return { mode: 'floating', x: 24, y: 24, w: null, h: null }
  }
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') ?? {} } catch { return {} }
}
function save(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* storage may be unavailable */ }
}

function initIslands() {
  const playground = document.querySelector('[data-island-playground]')
  if (!playground) return
  const preview = playground.querySelector('[data-dock-preview]')
  const shelf = playground.querySelector('[data-orb-shelf]')
  const hint = playground.querySelector('[data-playground-hint]')
  const reset = playground.querySelector('[data-reset-islands]')
  const islands = [...playground.querySelectorAll('[data-island]')]
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')

  const bounds = () => ({ width: playground.clientWidth, height: playground.clientHeight })
  const state = {}
  const stored = load()

  const clamp = (id) => {
    const s = state[id]
    const el = islands.find((i) => i.dataset.island === id)
    if (!s || !el || s.mode !== 'floating') return
    const { width: W, height: H } = bounds()
    const rect = { w: el.offsetWidth, h: el.offsetHeight }
    s.x = Math.min(Math.max(MARGIN, s.x), Math.max(MARGIN, W - rect.w - MARGIN))
    s.y = Math.min(Math.max(MARGIN, s.y), Math.max(MARGIN, H - rect.h - MARGIN))
  }

  const apply = (id) => {
    const el = islands.find((i) => i.dataset.island === id)
    const s = state[id]
    if (!el || !s) return
    el.dataset.mode = s.mode === 'orb' ? 'floating' : s.mode
    el.style.setProperty('--x', `${Math.round(s.x)}px`)
    el.style.setProperty('--y', `${Math.round(s.y)}px`)
    el.style.setProperty('--w', s.w ? `${Math.round(s.w)}px` : 'auto')
    el.style.setProperty('--h', s.h ? `${Math.round(s.h)}px` : 'auto')
    el.hidden = s.mode === 'orb'
  }

  const persist = () => save(state)

  const setHint = (message) => { if (hint) hint.textContent = message }

  // ---- Orbs ----
  const orbFor = (id) => shelf.querySelector(`[data-orb="${id}"]`)
  const currentToolIcon = () => {
    const active = playground.querySelector('[data-island="toolbar"] .tool-list .is-active use')
    return active?.getAttribute('href') ?? ICONS.toolbar
  }
  const makeOrb = (id) => {
    const orb = document.createElement('button')
    orb.type = 'button'
    orb.className = 'orb'
    orb.dataset.orb = id
    orb.setAttribute('aria-label', `恢复${NAMES[id] ?? id}`)
    orb.title = `恢复${NAMES[id] ?? id}`
    const icon = id === 'toolbar' ? currentToolIcon() : (ICONS[id] ?? '#i-orb')
    orb.innerHTML = `<svg class="icon" aria-hidden="true"><use href="${icon}"/></svg>${id === 'composer' ? '<span class="orb-dot is-active" aria-hidden="true"></span>' : ''}`
    orb.addEventListener('click', () => restore(id))
    return orb
  }

  const collapse = async (id) => {
    const el = islands.find((i) => i.dataset.island === id)
    if (!el || state[id].mode === 'orb') return
    const from = el.getBoundingClientRect()
    if (!orbFor(id)) shelf.append(makeOrb(id))
    const orb = orbFor(id)
    const to = orb.getBoundingClientRect()
    state[id].lastMode = state[id].mode
    state[id].mode = 'orb'
    persist()
    if (!reduce.matches) {
      const dx = (to.left + to.width / 2) - (from.left + from.width / 2)
      const dy = (to.top + to.height / 2) - (from.top + from.height / 2)
      const scale = Math.max(0.12, to.width / from.width)
      el.classList.add('is-collapsing')
      await el.animate(
        [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 }],
        { duration: 320, easing: 'cubic-bezier(.22,.8,.2,1)', fill: 'forwards' }
      ).finished.catch(() => undefined)
      el.classList.remove('is-collapsing')
    }
    el.hidden = true
    el.getAnimations().forEach((a) => a.cancel())
    setHint(`${NAMES[id]} 已收成圆球。点击圆球恢复。`)
    orb.focus({ preventScroll: true })
  }

  const restore = async (id) => {
    const el = islands.find((i) => i.dataset.island === id)
    const orb = orbFor(id)
    if (!el || !state[id] || state[id].mode !== 'orb') return
    state[id].mode = state[id].lastMode ?? 'floating'
    delete state[id].lastMode
    apply(id)      // un-hide first so clamp can measure the real size
    clamp(id)
    apply(id)
    persist()
    if (orb && !reduce.matches) {
      const from = orb.getBoundingClientRect()
      const to = el.getBoundingClientRect()
      const dx = (from.left + from.width / 2) - (to.left + to.width / 2)
      const dy = (from.top + from.height / 2) - (to.top + to.height / 2)
      const scale = Math.max(0.12, from.width / to.width)
      el.classList.add('is-restoring')
      await el.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 }, { transform: 'translate(0,0) scale(1)', opacity: 1 }],
        { duration: 320, easing: 'cubic-bezier(.22,.8,.2,1)' }
      ).finished.catch(() => undefined)
      el.classList.remove('is-restoring')
    }
    orb?.remove()
    setHint(`${NAMES[id]} 已恢复。`)
    el.querySelector('[data-grip]')?.focus({ preventScroll: true })
  }

  // ---- Dock zones ----
  const zoneAt = (clientX, clientY) => {
    const rect = playground.getBoundingClientRect()
    const x = clientX - rect.left, y = clientY - rect.top
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null
    if (x < EDGE) return 'docked-left'
    if (x > rect.width - EDGE) return 'docked-right'
    if (y < EDGE) return 'docked-top'
    if (y > rect.height - EDGE) return 'docked-bottom'
    return null
  }
  const showPreview = (zone) => {
    if (!zone) { preview.hidden = true; return }
    const { width: W, height: H } = bounds()
    const side = Math.min(340, W * 0.34)
    const geo = {
      'docked-left': { left: 18, top: 18, width: side, height: H - 36 },
      'docked-right': { left: W - 18 - side, top: 18, width: side, height: H - 36 },
      'docked-top': { left: W * 0.12, top: 18, width: W * 0.76, height: 130 },
      'docked-bottom': { left: W * 0.12, top: H - 18 - 130, width: W * 0.76, height: 130 }
    }[zone]
    Object.assign(preview.style, { left: `${geo.left}px`, top: `${geo.top}px`, width: `${geo.width}px`, height: `${geo.height}px` })
    preview.hidden = false
  }

  // ---- Drag ----
  for (const el of islands) {
    const id = el.dataset.island
    const grip = el.querySelector('[data-grip]')
    const collapseButton = el.querySelector('[data-collapse]')
    const resizeHandle = el.querySelector('[data-resize]')
    let drag = null

    const endDrag = (commit) => {
      if (!drag) return
      const { pointerId, zone } = drag
      drag = null
      try { grip.releasePointerCapture(pointerId) } catch { /* already released */ }
      el.classList.remove('is-dragging')
      showPreview(null)
      if (commit && zone) {
        state[id].mode = zone
        setHint(`${NAMES[id]} 已停靠到${{ 'docked-left': '左侧', 'docked-right': '右侧', 'docked-top': '顶部', 'docked-bottom': '底部' }[zone]}；顶部/底部停靠会变成横向布局。`)
      } else if (commit) {
        state[id].mode = 'floating'
      }
      clamp(id)
      apply(id)
      persist()
    }

    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('[data-collapse]')) return
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const pg = playground.getBoundingClientRect()
      // Undock on drag start: the island continues from where it visually is.
      if (state[id].mode !== 'floating') {
        state[id].mode = 'floating'
        state[id].x = rect.left - pg.left
        state[id].y = rect.top - pg.top
        apply(id)
      }
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: state[id].x, originY: state[id].y, zone: null }
      grip.setPointerCapture(event.pointerId)
      el.classList.add('is-dragging')
      islands.forEach((other) => { other.style.zIndex = other === el ? '9' : '' })
    })
    grip.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      const { width: W, height: H } = bounds()
      const nx = drag.originX + (event.clientX - drag.startX)
      const ny = drag.originY + (event.clientY - drag.startY)
      state[id].x = Math.min(Math.max(MARGIN, nx), Math.max(MARGIN, W - el.offsetWidth - MARGIN))
      state[id].y = Math.min(Math.max(MARGIN, ny), Math.max(MARGIN, H - el.offsetHeight - MARGIN))
      el.style.setProperty('--x', `${Math.round(state[id].x)}px`)
      el.style.setProperty('--y', `${Math.round(state[id].y)}px`)
      const zone = zoneAt(event.clientX, event.clientY)
      if (zone !== drag.zone) { drag.zone = zone; showPreview(zone) }
    })
    grip.addEventListener('pointerup', (event) => { if (drag && event.pointerId === drag.pointerId) endDrag(true) })
    grip.addEventListener('pointercancel', () => endDrag(false))
    grip.addEventListener('lostpointercapture', () => endDrag(false))
    window.addEventListener('blur', () => endDrag(false))

    // Keyboard: arrows move (Shift = 32px), Enter/Space collapse, Escape cancels a drag.
    grip.addEventListener('keydown', (event) => {
      if (event.target !== grip) return   // the collapse button handles its own keys
      const step = event.shiftKey ? 32 : 8
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (moves[event.key]) {
        event.preventDefault()
        if (state[id].mode !== 'floating') { const r = el.getBoundingClientRect(), pg = playground.getBoundingClientRect(); state[id].mode = 'floating'; state[id].x = r.left - pg.left; state[id].y = r.top - pg.top }
        state[id].x += moves[event.key][0]
        state[id].y += moves[event.key][1]
        clamp(id); apply(id); persist()
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); collapse(id)
      } else if (event.key === 'Escape' && drag) {
        endDrag(false)
      }
    })

    collapseButton?.addEventListener('click', () => collapse(id))

    // Resize from the corner handle only (floating mode).
    if (resizeHandle) {
      let rs = null
      resizeHandle.addEventListener('pointerdown', (event) => {
        if (state[id].mode !== 'floating') return
        event.preventDefault(); event.stopPropagation()
        rs = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, w: el.offsetWidth, h: el.offsetHeight }
        resizeHandle.setPointerCapture(event.pointerId)
        el.classList.add('is-dragging')
      })
      resizeHandle.addEventListener('pointermove', (event) => {
        if (!rs || event.pointerId !== rs.pointerId) return
        const { width: W, height: H } = bounds()
        state[id].w = Math.min(Math.max(MIN_W, rs.w + event.clientX - rs.startX), W - state[id].x - MARGIN)
        state[id].h = Math.min(Math.max(MIN_H, rs.h + event.clientY - rs.startY), H - state[id].y - MARGIN)
        el.style.setProperty('--w', `${Math.round(state[id].w)}px`)
        el.style.setProperty('--h', `${Math.round(state[id].h)}px`)
      })
      const endResize = () => { if (!rs) return; try { resizeHandle.releasePointerCapture(rs.pointerId) } catch { /* noop */ } rs = null; el.classList.remove('is-dragging'); persist() }
      resizeHandle.addEventListener('pointerup', endResize)
      resizeHandle.addEventListener('pointercancel', endResize)
      resizeHandle.addEventListener('lostpointercapture', endResize)
    }
  }

  // Tool buttons: real toggles, and the toolbar orb reflects the active tool.
  playground.querySelectorAll('.tool-list button[data-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      button.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === button))
      setHint(`当前工具：${button.getAttribute('aria-label')}`)
    })
  })

  // ---- Init / reset / resize ----
  const initState = (fromStorage) => {
    const b = bounds()
    for (const el of islands) {
      const id = el.dataset.island
      const def = defaultsFor(id, b)
      const s = fromStorage ? stored[id] : null
      state[id] = s && typeof s === 'object' ? { ...def, ...s } : def
      if (!['floating', 'docked-left', 'docked-right', 'docked-top', 'docked-bottom', 'orb'].includes(state[id].mode)) state[id].mode = 'floating'
      for (const key of ['x', 'y']) if (!Number.isFinite(state[id][key])) state[id][key] = def[key]
      for (const key of ['w', 'h']) if (state[id][key] !== null && !Number.isFinite(state[id][key])) state[id][key] = def[key]
      if (state[id].mode === 'orb') { if (!orbFor(id)) shelf.append(makeOrb(id)) }
      clamp(id)
      apply(id)
    }
  }
  initState(true)

  reset?.addEventListener('click', () => {
    shelf.replaceChildren()
    for (const el of islands) { el.hidden = false; el.getAnimations().forEach((a) => a.cancel()) }
    initState(false)
    persist()
    setHint('布局已重置。')
  })

  new ResizeObserver(() => {
    // A tab switch temporarily removes layout; zero bounds must not overwrite
    // the saved floating coordinates of the instruments.
    if (playground.clientWidth === 0 || playground.clientHeight === 0) return
    for (const el of islands) { clamp(el.dataset.island); apply(el.dataset.island) }
  }).observe(playground)
}
window.AICanvasSite = Object.assign(window.AICanvasSite ?? {}, { initIslands })
})()
