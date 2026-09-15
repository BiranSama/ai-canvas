// Three focuses: one Scene, three projections. Scrolling the steps (or clicking
// the mini view switcher) morphs the same DOM objects between layouts — a real
// shared-object transition, not three screenshots.
(() => {
const COPY = {
  conversation: { text: '描述你想创建或调整的画面…', state: '已完成' },
  canvas: { text: '描述你想调整的画面…', state: '待命' },
  generate: { text: '4:5 · 2 张 · 安静的商品海报，清晨侧光，保留主体…', state: '继续生成' }
}

function initFocus() {
  const stage = document.querySelector('[data-focus-stage]')
  if (!stage) return
  const tabs = [...stage.querySelectorAll('[data-focus-tab]')]
  const steps = [...document.querySelectorAll('[data-focus-step]')]
  const text = stage.querySelector('[data-composer-text]')
  const state = stage.querySelector('[data-composer-state]')

  const artwork = stage.querySelector('[data-el="artwork"]')
  const space = stage.querySelector('.mini-space')
  const currentSlot = stage.querySelector('.mini-result.is-current .poster-mini')

  // In the generate focus the artwork must land exactly on the "current" result slot.
  // Measure the slot (its layout does not depend on the artwork) and pin the artwork
  // to it with inline percentages, so the CSS transition carries it there precisely.
  const pinArtworkToSlot = () => {
    if (!artwork || !space || !currentSlot) return
    const s = space.getBoundingClientRect()
    const r = currentSlot.getBoundingClientRect()
    artwork.style.setProperty('--ex', `${((r.left - s.left) / s.width * 100).toFixed(3)}%`)
    artwork.style.setProperty('--ey', `${((r.top - s.top) / s.height * 100).toFixed(3)}%`)
    artwork.style.setProperty('--ew', `${(r.width / s.width * 100).toFixed(3)}%`)
    artwork.style.setProperty('--eh', `${(r.height / s.height * 100).toFixed(3)}%`)
  }
  const unpinArtwork = () => { if (!artwork) return; ['--ex', '--ey', '--ew', '--eh'].forEach((p) => artwork.style.removeProperty(p)) }

  let current = null
  const setView = (view) => {
    if (!COPY[view] || view === current) return
    current = view
    stage.dataset.view = view
    if (view === 'generate') pinArtworkToSlot(); else unpinArtwork()
    tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.focusTab === view)))
    steps.forEach((step) => step.classList.toggle('is-active', step.dataset.focusStep === view))
    if (text) text.textContent = COPY[view].text
    if (state) state.textContent = COPY[view].state
  }
  new ResizeObserver(() => { if (current === 'generate') pinArtworkToSlot() }).observe(stage)

  tabs.forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.focusTab)))

  const narrow = matchMedia('(max-width: 900px)')
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) setView(entry.target.dataset.focusStep)
  }, { rootMargin: narrow.matches ? '-20% 0px -60% 0px' : '-45% 0px -45% 0px', threshold: 0 })
  steps.forEach((step) => io.observe(step))

  setView('conversation')
}
window.AICanvasSite = Object.assign(window.AICanvasSite ?? {}, { initFocus })
})()
