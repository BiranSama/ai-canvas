// Themes & materials. The demo frame previews any combination; "apply to page"
// mirrors it to the whole document with a View Transition. The nav button cycles
// the page theme. The system option follows prefers-color-scheme, exactly like the
// product's resolveEffectiveAppearanceTheme.
(() => {
const STORAGE_KEY = 'ai-canvas-site-theme-v1'
const ORDER = ['pearl', 'obsidian', 'dusk', 'system']
const NAMES = { pearl: '月白', obsidian: '夜墨', dusk: '暮蓝', system: '跟随系统' }
const THEME_COLOR = { pearl: '#f5f7fa', obsidian: '#171a20', dusk: '#202a35' }
const TOKENS = ['--pearl', '--ink', '--cobalt', '--iris', '--champagne', '--glass-blur']

const dark = matchMedia('(prefers-color-scheme: dark)')
const reduce = matchMedia('(prefers-reduced-motion: reduce)')
const resolve = (theme) => theme === 'system' ? (dark.matches ? 'obsidian' : 'pearl') : theme

function load() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') } catch { return null } }
function save(value) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* noop */ } }

function initTheme() {
  const root = document.documentElement
  const frame = document.querySelector('[data-theme-frame]')
  const themePicks = [...document.querySelectorAll('[data-theme-pick]')]
  const materialPicks = [...document.querySelectorAll('[data-material-pick]')]
  const applyPage = document.querySelector('[data-apply-page]')
  const readout = [...document.querySelectorAll('[data-token]')]
  const cycle = document.querySelector('[data-theme-cycle]')
  const cycleLabel = document.querySelector('[data-theme-label]')
  const metas = [...document.querySelectorAll('meta[name="theme-color"]')]

  const stored = load()
  const page = {
    theme: ORDER.includes(stored?.theme) ? stored.theme : 'system',
    material: ['crystal', 'satin', 'solid'].includes(stored?.material) ? stored.material : 'crystal'
  }
  const demo = { theme: 'pearl', material: 'crystal' }

  const updateReadout = () => {
    if (!frame) return
    const cs = getComputedStyle(frame)
    for (const dd of readout) {
      const name = dd.dataset.token
      const value = cs.getPropertyValue(name).trim()
      dd.textContent = value
      if (value.startsWith('#') || value.startsWith('rgb')) dd.style.setProperty('--swatch', value)
      else dd.classList.add('no-swatch')
    }
  }

  const setDemo = () => {
    if (!frame) return
    frame.dataset.theme = resolve(demo.theme)
    frame.dataset.material = demo.material
    updateReadout()
  }

  const commitPage = () => {
    root.dataset.theme = resolve(page.theme)
    root.dataset.material = page.material
    if (cycleLabel) cycleLabel.textContent = NAMES[page.theme]
    metas.forEach((m) => m.setAttribute('content', THEME_COLOR[resolve(page.theme)]))
    document.dispatchEvent(new CustomEvent('themechange', { detail: { ...page, effective: resolve(page.theme) } }))
  }

  const setPage = (next, origin) => {
    Object.assign(page, next)
    save(page)
    if (document.startViewTransition && !reduce.matches) {
      if (origin) {
        const r = origin.getBoundingClientRect()
        root.style.setProperty('--vt-x', `${((r.left + r.width / 2) / innerWidth * 100).toFixed(1)}%`)
        root.style.setProperty('--vt-y', `${((r.top + r.height / 2) / innerHeight * 100).toFixed(1)}%`)
      }
      document.startViewTransition(() => commitPage())
    } else {
      commitPage()
    }
  }

  themePicks.forEach((input) => input.addEventListener('change', () => {
    if (!input.checked) return
    demo.theme = input.value
    setDemo()
    if (applyPage?.checked) setPage({ theme: demo.theme }, input.closest('label'))
  }))
  materialPicks.forEach((input) => input.addEventListener('change', () => {
    if (!input.checked) return
    demo.material = input.value
    setDemo()
    if (applyPage?.checked) setPage({ material: demo.material }, input.closest('label'))
  }))
  applyPage?.addEventListener('change', () => {
    if (applyPage.checked) setPage({ theme: demo.theme, material: demo.material }, applyPage.closest('label'))
    else setPage({ theme: 'system', material: 'crystal' }, applyPage.closest('label'))
  })
  cycle?.addEventListener('click', () => {
    const next = ORDER[(ORDER.indexOf(page.theme) + 1) % ORDER.length]
    setPage({ theme: next }, cycle)
    if (applyPage) applyPage.checked = false
  })
  dark.addEventListener('change', () => { if (page.theme === 'system') commitPage(); if (demo.theme === 'system') setDemo() })

  // Sync the demo radios to the stored page preference on first paint.
  const initialDemoTheme = themePicks.find((i) => i.checked)?.value ?? 'pearl'
  demo.theme = initialDemoTheme
  commitPage()
  setDemo()
}
window.AICanvasSite = Object.assign(window.AICanvasSite ?? {}, { initTheme })
})()
