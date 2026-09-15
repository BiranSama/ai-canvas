// Reference Compiler pipeline: a pinned, scroll-scrubbed horizontal track. Progress
// through the pinned region moves the track so the active stage centres itself; links
// between stages light up as the compilation advances.
(() => {
const SVG_NS = 'http://www.w3.org/2000/svg'

function initCompiler() {
  const pin = document.querySelector('[data-pipeline]')
  if (!pin) return
  const sticky = pin.querySelector('.pipeline-sticky')
  const track = pin.querySelector('[data-pipeline-track]')
  const bar = pin.querySelector('[data-pipeline-bar]')
  const links = pin.querySelector('[data-pipeline-links]')
  const stages = [...track.children]
  const narrow = matchMedia('(max-width: 900px)')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')

  stages.forEach((stage) => stage.querySelectorAll('.stage-fields code').forEach((code, i) => code.style.setProperty('--fi', String(i))))

  let centers = []
  let paths = []

  const layout = () => {
    if (narrow.matches) return
    const tr = track.getBoundingClientRect()
    centers = stages.map((s) => { const r = s.getBoundingClientRect(); return r.left - tr.left + r.width / 2 })
    links.replaceChildren()
    paths = []
    stages.forEach((s, i) => {
      if (i === 0) return
      const a = stages[i - 1].getBoundingClientRect()
      const b = s.getBoundingClientRect()
      const x1 = a.right - tr.left, x2 = b.left - tr.left
      const y = a.top - tr.top + Math.min(a.height, b.height) * 0.5
      const path = document.createElementNS(SVG_NS, 'path')
      const mid = (x2 - x1) / 2
      path.setAttribute('d', `M ${x1} ${y} C ${x1 + mid} ${y}, ${x2 - mid} ${y}, ${x2} ${y}`)
      path.setAttribute('class', 'plink')
      path.style.cssText = 'fill:none;stroke:color-mix(in srgb, var(--ink) 16%, transparent);stroke-width:1.5;stroke-dasharray:4 6;transition:stroke 300ms'
      links.append(path)
      paths.push(path)
    })
    // Overlay the SVG exactly on the (untranslated) track box inside the sticky frame.
    links.setAttribute('viewBox', `0 0 ${tr.width} ${tr.height}`)
    links.style.inset = 'auto'
    links.style.left = `${track.offsetLeft}px`
    links.style.top = `${track.offsetTop}px`
    links.style.width = `${tr.width}px`
    links.style.height = `${tr.height}px`
  }

  let active = -1
  const setActive = (index) => {
    if (index === active) return
    active = index
    stages.forEach((s, i) => s.classList.toggle('is-active', i === index))
    paths.forEach((p, i) => { p.style.stroke = i < index ? 'var(--cobalt)' : ''; p.style.strokeDasharray = i < index ? 'none' : '' })
  }

  let ticking = false
  const update = () => {
    ticking = false
    if (narrow.matches) { setActive(-1); return }
    const rect = pin.getBoundingClientRect()
    const stickyTop = parseFloat(getComputedStyle(sticky).top) || 0
    const total = pin.offsetHeight - sticky.offsetHeight
    const p = Math.min(1, Math.max(0, (stickyTop - rect.top) / Math.max(1, total)))
    const n = stages.length
    const pos = p * (n - 1)
    const i0 = Math.floor(pos), i1 = Math.min(n - 1, i0 + 1)
    const f = pos - i0
    const cx = centers[i0] + (centers[i1] - centers[i0]) * f
    const stickyW = sticky.clientWidth
    const tx = stickyW / 2 - cx
    track.style.setProperty('--tx', `${tx.toFixed(1)}px`)
    links.style.translate = `${tx.toFixed(1)}px 0`
    bar.style.setProperty('--p', p.toFixed(4))
    setActive(Math.round(pos))
  }
  const request = () => { if (!ticking) { ticking = true; requestAnimationFrame(update) } }

  layout()
  update()
  addEventListener('scroll', request, { passive: true })
  new ResizeObserver(() => { layout(); request() }).observe(sticky)
  narrow.addEventListener('change', () => { layout(); request() })
  if (reduce.matches) track.style.transition = 'none'
}
window.AICanvasSite = Object.assign(window.AICanvasSite ?? {}, { initCompiler })
})()
