// Prismatic Action Trace demo. Executing a command produces a real state change on
// the poster, an observable activity record (action / scope / objects / result /
// state / undo), and — only because real objects were affected — a thin spectral
// path from the composer to each affected object that dissolves on its own.
(() => {
const HOLD_MS = 2400
const MAX_TARGETS = 3

const COMMANDS = {
  'shrink-title': {
    text: '把标题收小一点，保留主体。',
    action: '更新画布结构',
    scope: '当前选区 · 准确主标题',
    targets: ['title'],
    protect: ['subject'],
    result: '标题字号 96 → 72；主体与构图未修改',
    apply: (p) => p.title.style.setProperty('--size', '0.72'),
    revert: (p) => p.title.style.setProperty('--size', '1')
  },
  'morning-light': {
    text: '沿用构图，光线改成清晨侧光。',
    action: '调整光影',
    scope: '当前画布 · 清晨侧光',
    targets: ['light'],
    anchors: { light: [0.84, 0.16] },
    protect: ['subject', 'title'],
    result: '光源 左上 → 右上；已记录为本轮偏好',
    apply: (p) => { p.light.style.setProperty('--glow-x', '84%'); p.light.style.setProperty('--glow-y', '16%') },
    revert: (p) => { p.light.style.setProperty('--glow-x', '22%'); p.light.style.setProperty('--glow-y', '10%') }
  },
  'foot-right': {
    text: '把底部说明移到右侧。',
    action: '移动元素',
    scope: '当前选区 · 说明文字',
    targets: ['foot'],
    protect: [],
    result: '说明文字 左下 → 右下',
    apply: (p) => p.foot.classList.add('is-right'),
    revert: (p) => p.foot.classList.remove('is-right')
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function initTrace() {
  const stage = document.querySelector('[data-trace-stage]')
  if (!stage) return
  const overlay = stage.querySelector('[data-trace-overlay]')
  const poster = stage.querySelector('[data-trace-poster]')
  const list = stage.querySelector('[data-trace-activities]')
  const empty = stage.querySelector('[data-trace-empty]')
  const count = stage.querySelector('[data-trace-count]')
  const composer = stage.querySelector('[data-trace-composer]')
  const text = stage.querySelector('[data-trace-text]')
  const stateLabel = stage.querySelector('[data-trace-state]')
  const scopeLabel = stage.querySelector('[data-trace-scope]')
  const run = stage.querySelector('[data-trace-run]')
  const presets = [...stage.querySelectorAll('[data-trace-cmd]')]
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')

  const parts = {
    title: poster.querySelector('[data-trace-el="title"]'),
    light: poster.querySelector('[data-trace-el="light"]'),
    subject: poster.querySelector('[data-trace-el="subject"]'),
    foot: poster.querySelector('[data-trace-el="foot"]')
  }
  const NAMES = { title: '准确主标题', light: '清晨侧光', subject: '香氛瓶身', foot: '说明文字' }

  let current = 'shrink-title'
  let busy = false
  let sequence = 0
  const applied = new Map()

  presets.forEach((button) => button.addEventListener('click', () => {
    current = button.dataset.traceCmd
    presets.forEach((b) => b.classList.toggle('is-active', b === button))
    text.textContent = COMMANDS[current].text
    scopeLabel.textContent = COMMANDS[current].scope
  }))

  const setState = (label, running) => {
    stateLabel.textContent = label
    stateLabel.classList.toggle('is-running', running)
  }

  const drawTrace = (targetIds, anchors = {}) => {
    overlay.replaceChildren()
    const rect = overlay.getBoundingClientRect()
    const c = composer.getBoundingClientRect()
    const origin = { x: c.left + c.width / 2 - rect.left, y: c.top - rect.top }
    const targets = targetIds.map((id) => [id, parts[id]]).filter(([, el]) => Boolean(el)).slice(0, MAX_TARGETS)
    if (targets.length === 0) return
    targets.forEach(([id, el], index) => {
      const r = el.getBoundingClientRect()
      const [ax, ay] = anchors[id] ?? [0.5, 0.5]
      const tx = r.left + r.width * ax - rect.left
      const ty = r.top + r.height * ay - rect.top
      const dy = ty - origin.y
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('class', 'trace-path')
      path.setAttribute('d', `M ${origin.x} ${origin.y} C ${origin.x} ${origin.y + dy * 0.42}, ${tx} ${ty - dy * 0.32}, ${tx} ${ty}`)
      path.setAttribute('pathLength', '1')
      path.style.setProperty('--d1', `${index * 70}ms`)
      path.style.setProperty('--d2', `${1700 + index * 70}ms`)
      const dot = document.createElementNS(SVG_NS, 'circle')
      dot.setAttribute('class', 'trace-endpoint')
      dot.setAttribute('cx', tx); dot.setAttribute('cy', ty); dot.setAttribute('r', '3')
      dot.style.setProperty('--d1', `${380 + index * 70}ms`)
      dot.style.setProperty('--d2', `${1700 + index * 70}ms`)
      overlay.append(path, dot)
      el.classList.add('is-touched')
      setTimeout(() => el.classList.remove('is-touched'), HOLD_MS)
    })
    setTimeout(() => overlay.replaceChildren(), HOLD_MS + 200)
  }

  const record = (command, id) => {
    const li = document.createElement('li')
    li.dataset.activity = id
    li.innerHTML = `
      <b>${command.action}<span class="state is-running">正在进行</span></b>
      <span>${command.scope}</span>
      <span>受影响：${command.targets.map((t) => NAMES[t]).join('、')}${command.protect.length ? ` · 保护：${command.protect.map((t) => NAMES[t]).join('、')}` : ''}</span>
      <span data-result hidden></span>
      <em hidden><button type="button" data-locate>定位</button><button type="button" data-undo>撤销</button></em>`
    list.prepend(li)
    empty.hidden = true
    count.textContent = `${list.children.length} 条真实记录`
    return li
  }

  const complete = (li, command, id) => {
    const state = li.querySelector('.state')
    state.textContent = '已完成'
    state.className = 'state is-done'
    const result = li.querySelector('[data-result]')
    result.textContent = `结果：${command.result}`
    result.hidden = false
    const actions = li.querySelector('em')
    actions.hidden = false
    actions.querySelector('[data-locate]').addEventListener('click', () => {
      command.targets.forEach((t) => { parts[t]?.classList.add('is-touched'); setTimeout(() => parts[t]?.classList.remove('is-touched'), 1200) })
    })
    actions.querySelector('[data-undo]').addEventListener('click', () => {
      if (!applied.has(id)) return
      command.revert(parts)
      applied.delete(id)
      state.textContent = '已撤销'
      state.className = 'state'
      actions.hidden = true
    }, { once: true })
  }

  const execute = async () => {
    if (busy) return
    const command = COMMANDS[current]
    busy = true
    run.disabled = true
    const id = `act-${++sequence}`
    setState('正在执行', true)
    const li = record(command, id)
    await wait(reduce.matches ? 60 : 260)
    drawTrace(command.targets, command.anchors)   // only because command.targets are real elements
    await wait(reduce.matches ? 60 : 380)
    command.apply(parts)                // the real state transition the trace corresponds to
    applied.set(id, command)
    await wait(reduce.matches ? 120 : 620)
    complete(li, command, id)
    setState('已完成', false)
    run.disabled = false
    busy = false
  }

  run.addEventListener('click', execute)
}
window.AICanvasSite = Object.assign(window.AICanvasSite ?? {}, { initTrace })
})()
