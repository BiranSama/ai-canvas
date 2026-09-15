// Execution contract: a live state machine. A packet travels propose → preview →
// commit-check → persist. If the user edited the canvas after preview, the current
// revision no longer matches expectedSceneRevision and the commit is rejected.
(() => {
const SVG_NS = 'http://www.w3.org/2000/svg'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function initContract() {
  const root = document.querySelector('[data-contract]')
  if (!root) return
  const nodes = Object.fromEntries([...root.querySelectorAll('[data-cnode]')].map((el) => [el.dataset.cnode, el]))
  const links = root.querySelector('[data-contract-links]')
  const packet = root.querySelector('[data-packet]')
  const manual = root.querySelector('[data-manual-edit]')
  const runButton = root.querySelector('[data-run-commit]')
  const log = root.querySelector('[data-contract-log]')
  const expectedEl = root.querySelector('[data-expected-rev]')
  const currentEl = root.querySelector('[data-current-rev]')
  const verdict = root.querySelector('[data-verdict]')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  const narrow = matchMedia('(max-width: 900px)')

  let revision = 12
  let batch = 0
  let busy = false
  const paths = {}

  const center = (el, side) => {
    const r = el.getBoundingClientRect(), o = root.getBoundingClientRect()
    const x = side === 'right' ? r.right - o.left : side === 'left' ? r.left - o.left : r.left - o.left + r.width / 2
    const y = side === 'bottom' ? r.bottom - o.top : side === 'top' ? r.top - o.top : r.top - o.top + r.height / 2
    return { x, y }
  }
  const layout = () => {
    links.replaceChildren()
    if (narrow.matches) return
    const o = root.getBoundingClientRect()
    links.setAttribute('viewBox', `0 0 ${o.width} ${o.height}`)
    const make = (name, d, cls = '') => {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      if (cls) path.setAttribute('class', cls)
      links.append(path)
      paths[name] = path
    }
    const p1 = center(nodes.propose, 'right'), p2 = center(nodes.preview, 'left')
    make('propose-preview', `M ${p1.x} ${p1.y} C ${p1.x + 16} ${p1.y}, ${p2.x - 16} ${p2.y}, ${p2.x} ${p2.y}`)
    const p3 = center(nodes.preview, 'right'), p4 = center(nodes.check, 'left')
    make('preview-check', `M ${p3.x} ${p3.y} C ${p3.x + 16} ${p3.y}, ${p4.x - 16} ${p4.y}, ${p4.x} ${p4.y}`)
    const p5 = center(nodes.check, 'right'), p6 = center(nodes.persist, 'left')
    make('check-persist', `M ${p5.x} ${p5.y} C ${p5.x + 16} ${p5.y}, ${p6.x - 16} ${p6.y}, ${p6.x} ${p6.y}`)
    const p7 = center(nodes.check, 'bottom'), p8 = center(nodes.reject, 'top')
    make('check-reject', `M ${p7.x} ${p7.y} C ${p7.x} ${p7.y + 20}, ${p8.x} ${p8.y - 20}, ${p8.x} ${p8.y}`)
  }

  const travel = async (name, reject = false) => {
    const path = paths[name]
    if (!path) { await wait(reduce.matches ? 80 : 300); return }
    path.classList.add(reject ? 'is-reject' : 'is-lit')
    if (reduce.matches) return
    const length = path.getTotalLength()
    packet.classList.toggle('is-reject', reject)
    packet.style.opacity = '1'
    const duration = 520
    const t0 = performance.now()
    await new Promise((resolve) => {
      const step = (now) => {
        const t = Math.min(1, (now - t0) / duration)
        const eased = 1 - Math.pow(1 - t, 3)
        const point = path.getPointAtLength(length * eased)
        packet.style.left = `${point.x}px`
        packet.style.top = `${point.y}px`
        if (t < 1) requestAnimationFrame(step); else resolve()
      }
      requestAnimationFrame(step)
    })
    packet.style.opacity = '0'
  }

  const resetVisual = () => {
    Object.values(nodes).forEach((n) => n.classList.remove('is-active', 'is-ok', 'is-rejected'))
    Object.values(paths).forEach((p) => p.classList.remove('is-lit', 'is-reject'))
    verdict.textContent = '等待提交'
  }

  const runCommit = async () => {
    if (busy) return
    busy = true
    runButton.disabled = true
    resetVisual()
    const expected = revision
    expectedEl.textContent = String(expected)
    currentEl.textContent = String(revision)
    nodes.propose.classList.add('is-active')
    log.textContent = `提议：scope=当前选区 · 命令已通过策略与锁定检查`
    await wait(reduce.matches ? 120 : 420)
    await travel('propose-preview')
    nodes.preview.classList.add('is-active')
    log.textContent = `预览：影子执行完成，expectedSceneRevision = ${expected}，已生成 patches / inversePatches`
    await wait(reduce.matches ? 120 : 520)
    if (manual.checked) {
      revision += 1
      currentEl.textContent = String(revision)
      log.textContent = `用户在预览之后手动编辑了画布：权威 Scene revision ${expected} → ${revision}`
      await wait(reduce.matches ? 120 : 700)
    }
    await travel('preview-check')
    nodes.check.classList.add('is-active')
    await wait(reduce.matches ? 80 : 360)
    if (revision === expected) {
      verdict.textContent = `一致：${expected} = ${revision}，允许提交`
      nodes.check.classList.add('is-ok')
      await travel('check-persist')
      revision += 1
      batch += 1
      currentEl.textContent = String(revision)
      nodes.persist.classList.add('is-ok')
      log.textContent = `已提交：batch #${batch} 持久化，Scene revision → ${revision}，本地可撤销；外部请求与费用不随撤销消失`
    } else {
      verdict.textContent = `不一致：期望 ${expected}，实际 ${revision}`
      nodes.check.classList.add('is-rejected')
      await travel('check-reject', true)
      nodes.reject.classList.add('is-rejected')
      log.textContent = `拒绝：旧版本提交被拒绝。请重新读取权威 Scene（revision ${revision}），重新预览后再提交`
    }
    runButton.disabled = false
    busy = false
  }

  runButton.addEventListener('click', runCommit)
  layout()
  new ResizeObserver(layout).observe(root)
  log.textContent = `Scene revision ${revision} · 尚未提交`
}
window.AICanvasSite = Object.assign(window.AICanvasSite ?? {}, { initContract })
})()
