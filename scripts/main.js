// AI Canvas marketing site — bootstrap.
// Zero dependencies, classic deferred scripts (so the page also runs from file://).
// Every module registers itself on window.AICanvasSite; each is defensive: missing markup means a no-op.
(() => {
const site = window.AICanvasSite ?? {}
const { initHero, initFocus, initIslands, initTrace, initCompiler, initContract, initRuntime, initTheme } = site

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const supportsViewTimeline = CSS.supports('animation-timeline: view()')
const supportsScrollTimeline = CSS.supports('animation-timeline: scroll()')

function detectOpticalQuality() {
  const cores = navigator.hardwareConcurrency ?? 4
  const refraction = CSS.supports('backdrop-filter', 'url("#liquid-glass-fine") blur(1px)')
    || CSS.supports('-webkit-backdrop-filter', 'url("#liquid-glass-fine") blur(1px)')
  const quality = refraction && cores >= 8 ? 'fine' : cores >= 4 ? 'balanced' : 'performance'
  document.documentElement.dataset.optical = quality
  document.documentElement.dataset.motion = reduceMotion.matches ? 'reduced' : 'full'
}

function initReveals() {
  const hero = [...document.querySelectorAll('.hero [data-reveal]')]
  requestAnimationFrame(() => requestAnimationFrame(() => hero.forEach((el) => el.classList.add('is-in'))))

  if (supportsViewTimeline && !reduceMotion.matches) return
  const rest = [...document.querySelectorAll('[data-reveal]')].filter((el) => !el.closest('.hero'))
  if (reduceMotion.matches) { rest.forEach((el) => el.classList.add('is-in')); return }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target) }
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 })
  rest.forEach((el) => io.observe(el))
}

function initNav() {
  const nav = document.querySelector('[data-nav]')
  if (!nav) return
  const links = [...nav.querySelectorAll('.nav-links a')]
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]))
  let ticking = false
  const onScroll = () => {
    if (ticking) return
    ticking = true
    requestAnimationFrame(() => {
      nav.classList.toggle('is-scrolled', window.scrollY > 24)
      ticking = false
    })
  }
  addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const link = byId.get(entry.target.id)
      if (!link) continue
      if (entry.isIntersecting) {
        links.forEach((a) => a.classList.remove('is-current'))
        link.classList.add('is-current')
      }
    }
  }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 })
  byId.forEach((_, id) => { const section = document.getElementById(id); if (section) io.observe(section) })
}

function initManifesto() {
  const lines = [...document.querySelectorAll('[data-word]')]
  if (lines.length === 0) return
  if (reduceMotion.matches) { lines.forEach((el) => el.classList.add('is-lit')); return }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.classList.toggle('is-lit', entry.isIntersecting)
  }, { rootMargin: '-38% 0px -38% 0px', threshold: 0 })
  lines.forEach((el) => io.observe(el))
}

function initHeroStage() {
  const stage = document.querySelector('[data-hero-stage]')
  const device = document.querySelector('[data-device]')
  if (!stage || !device) return
  const useJsTilt = !supportsScrollTimeline && !reduceMotion.matches
  let ticking = false
  const update = () => {
    ticking = false
    const t = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.6)))
    stage.classList.toggle('is-flat', t > 0.96)
    if (useJsTilt) {
      device.style.setProperty('--tilt', `${(14 * (1 - t)).toFixed(2)}deg`)
      device.style.setProperty('--rise', `${(40 * (1 - t)).toFixed(1)}px`)
      device.style.setProperty('--zoom', (0.96 + 0.04 * t).toFixed(3))
    }
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update) } }, { passive: true })
  update()
  if (reduceMotion.matches) stage.classList.add('is-flat')
}

function boot() {
  detectOpticalQuality()
  initTheme?.()
  initReveals()
  initNav()
  initManifesto()
  initHeroStage()
  initGallery()
  initHero?.()
  initFocus?.()
  initIslands?.()
  initTrace?.()
  initCompiler?.()
  initContract?.()
  initRuntime?.()
}

function initGallery() {
  const gallery = document.querySelector('[data-gallery]')
  if (!gallery) return
  const track = gallery.querySelector('[data-gallery-track]')
  const dots = [...gallery.querySelectorAll('[data-gallery-dot]')]
  const slides = [...track.children]
  const prev = gallery.querySelector('[data-gallery-prev]')
  const next = gallery.querySelector('[data-gallery-next]')
  const goTo = (index) => {
    const slide = slides[(index + slides.length) % slides.length]
    const left = track.scrollLeft + slide.getBoundingClientRect().left - track.getBoundingClientRect().left
    track.scrollTo({ left, behavior: reduceMotion.matches ? 'instant' : 'smooth' })
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const index = slides.indexOf(entry.target)
      dots.forEach((dot, i) => dot.setAttribute('aria-current', String(i === index)))
      slides.forEach((s, i) => s.classList.toggle('is-active', i === index))
    }
  }, { root: track, threshold: 0.6 })
  slides.forEach((slide) => io.observe(slide))
  dots.forEach((dot, i) => dot.addEventListener('click', () => goTo(i)))
  prev?.addEventListener('click', () => goTo(slides.findIndex((s) => s.classList.contains('is-active')) - 1))
  next?.addEventListener('click', () => goTo(slides.findIndex((s) => s.classList.contains('is-active')) + 1))
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
else boot()
})()
