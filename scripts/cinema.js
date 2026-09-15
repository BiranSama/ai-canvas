(() => {
  const root = document.querySelector('[data-cinema]')
  if (!root) return
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  const rig = root.querySelector('[data-cinema-rig]')
  const heading = root.querySelector('.cinema-heading')
  const steps = [...root.querySelectorAll('[data-cinema-step]')]
  const lensButton = root.querySelector('[data-lens-toggle]')
  const lens = window.AICanvasSite?.initOpticalLens?.(root.querySelector('[data-optical-canvas]'), root.querySelector('.screen-fallback'))
  let frame = 0, chapter = -1, active = true, lensOn = false, pendingLens = false
  const chapters = [
    ['同一份 Scene', '让整个工作台，围绕作品展开。', '对话、画布与生成，共用同一份创作上下文。'],
    ['工具独立，创作连贯', '让工具浮起来，把空间还给作品。', '选择、检查、表达意图。各就其位，也能随手移动。'],
    ['你的创作，始终在中央', '每次生成之后，仍有无限下一步。', '保留想要的，修改需要的。在同一张画布上继续。']
  ]
  const clamp = value => Math.max(0,Math.min(1,value))
  const smooth = value => { const t=clamp(value); return t*t*(3-2*t) }
  const mix = (a,b,t) => a+(b-a)*t
  function draw() {
    frame = 0
    const rect = root.getBoundingClientRect()
    document.body.classList.toggle('in-cinema',rect.bottom>84&&rect.top<innerHeight)
    const h = root.querySelector('.cinema-sticky').clientHeight
    const w = root.clientWidth
    const narrow = w <= 700
    const progress = reduce.matches ? 0 : clamp(-rect.top / Math.max(1,root.offsetHeight-h))
    const entrance = smooth(progress/.34)
    const split = smooth((progress-.34)/.31)
    const focus = smooth((progress-.69)/.25)
    const titleFade = 1-smooth(progress/.22)
    const width = Math.min(narrow ? 620 : 1180,w*(narrow?.88:.8))
    const firstTop = narrow ? Math.max(h*.47,heading.offsetTop+heading.offsetHeight+26) : h*.58
    root.style.setProperty('--film-progress',progress.toFixed(4))
    root.style.setProperty('--heading-alpha',titleFade.toFixed(4))
    root.style.setProperty('--heading-y',`${-entrance*(narrow?70:130)}px`)
    root.style.setProperty('--chapter-alpha',smooth((progress-.18)/.16).toFixed(4))
    root.style.setProperty('--rig-top',`${mix(firstTop,h*(narrow?.38:.285),entrance)-focus*(narrow?10:0)}px`)
    root.style.setProperty('--rig-width',`${width}px`)
    root.style.setProperty('--rig-scale',String(mix(1.03,narrow?1:.75,entrance)-split*(narrow?.03:.09)))
    root.style.setProperty('--rig-rx',`${mix(narrow?14:24,0,entrance)+split*9}deg`)
    root.style.setProperty('--rig-ry',`${mix(narrow?-7:-14,0,entrance)-split*12}deg`)
    root.style.setProperty('--rig-rz',`${mix(2,0,entrance)}deg`)
    root.style.setProperty('--split',split.toFixed(4))
    root.style.setProperty('--focus-art',focus.toFixed(4))
    root.classList.toggle('is-split',split>.001)
    heading.inert = titleFade < .1
    const next = progress < .34 ? 0 : progress < .69 ? 1 : 2
    if (next !== chapter) {
      chapter=next
      const [kicker,title,description]=chapters[next]
      root.querySelector('[data-chapter-kicker]').textContent=kicker
      root.querySelector('[data-chapter-title]').textContent=title
      root.querySelector('[data-chapter-description]').textContent=description
      steps.forEach((step,index)=>{ if(index===next) step.setAttribute('aria-current','step'); else step.removeAttribute('aria-current') })
      root.dataset.chapter=String(next)
    }
    if(pendingLens&&split<=.001){pendingLens=false;lensOn=true;lens?.setEnabled(true)}
    if(split>.001 && lensOn){lensOn=false;lens?.setEnabled(false);lensButton.setAttribute('aria-pressed','false')}
  }
  function request(){if(!frame&&active&&!document.hidden)frame=requestAnimationFrame(draw)}
  function seek(index){
    const range=root.offsetHeight-root.querySelector('.cinema-sticky').clientHeight
    const target=root.getBoundingClientRect().top+scrollY+[0,.60,.92][index]*range
    window.scrollTo({top:target,behavior:reduce.matches?'instant':'smooth'})
  }
  steps.forEach((button,index)=>button.addEventListener('click',()=>seek(index)))
  lensButton.disabled=!lens||root.querySelector('[data-optical-canvas]').dataset.renderer==='image'
  root.querySelector('[data-optical-canvas]').addEventListener('opticalready',event=>{lensButton.disabled=!event.detail.ready})
  if(!lens)lensButton.title='当前浏览器使用静态截图预览'
  lensButton.addEventListener('click',()=>{
    const wanted=!lensOn&&!pendingLens
    pendingLens=wanted&&root.classList.contains('is-split')
    lensOn=wanted&&!pendingLens
    if(wanted){
      const range=root.offsetHeight-root.querySelector('.cinema-sticky').clientHeight
      window.scrollTo({top:root.getBoundingClientRect().top+scrollY+.30*range,behavior:reduce.matches?'instant':'smooth'})
      if(!pendingLens)lens?.setEnabled(true)
    }else lens?.setEnabled(false)
    lensButton.setAttribute('aria-pressed',String(wanted))
  })
  rig.addEventListener('pointermove',event=>{
    if(!lensOn)return
    const rect=root.querySelector('[data-screen-core]').getBoundingClientRect()
    lens?.move(clamp((event.clientX-rect.left)/rect.width),clamp((event.clientY-rect.top)/rect.height))
  },{passive:true})
  addEventListener('scroll',request,{passive:true})
  addEventListener('resize',request)
  document.addEventListener('visibilitychange',request)
  reduce.addEventListener('change',request)
  new IntersectionObserver(([entry])=>{active=entry.isIntersecting;if(active)request();else document.body.classList.remove('in-cinema')}).observe(root)
  draw()
})()
