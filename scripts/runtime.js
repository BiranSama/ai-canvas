// Generation runtime decision tree: which branch a request outcome takes, and why a
// timeout is never treated as proof that nothing was sent.
(() => {
const OUTCOMES = {
  not_sent: {
    lit: ['root', 'left-0', 'left-1', 'left-2'],
    links: ['root-left', 'left-1', 'left-2'],
    dim: ['right-0', 'right-1', 'right-2'],
    stop: false,
    log: '连接在发送前失败，提交状态为 not_sent，请求身份可核对：通过重试保护检查后，准备一次新的尝试。'
  },
  unknown: {
    lit: ['root', 'right-0', 'right-1', 'right-2'],
    links: ['root-right', 'right-1', 'right-2'],
    dim: ['left-0', 'left-1', 'left-2'],
    stop: true,
    log: '超时发生在 POST 之后，服务端可能已经接收：进入 NO_REPOST。只查询与对账原任务，自动重复 POST 次数必须为 0；无法核对原请求配置、凭据版本或累计预算时，外部执行进入暂停处理路径。'
  },
  task_id: {
    lit: ['root', 'right-0', 'right-1', 'right-2'],
    links: ['root-right', 'right-1', 'right-2'],
    dim: ['left-0', 'left-1', 'left-2'],
    stop: true,
    log: '响应中已经带回外部任务 ID：这不是一次失败，而是一个需要跟踪的任务。禁止重发，轮询状态并把结果对账到原任务身份。'
  }
}

function initRuntime() {
  const root = document.querySelector('[data-runtime]')
  if (!root) return
  const svg = root.querySelector('[data-tree-svg]')
  const log = root.querySelector('[data-runtime-log]')
  const buttons = [...root.querySelectorAll('[data-outcome]')]
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  const timers = []
  let userSelected = false

  const show = (key) => {
    const outcome = OUTCOMES[key]
    if (!outcome) return
    timers.splice(0).forEach(clearTimeout)
    svg.querySelectorAll('[data-node]').forEach((n) => n.classList.remove('is-lit', 'is-dim'))
    svg.querySelectorAll('[data-link]').forEach((l) => { l.classList.remove('is-lit', 'is-stop'); l.style.animation = 'none'; void l.getBBox(); l.style.animation = '' })
    outcome.dim.forEach((id) => svg.querySelector(`[data-node="${id}"]`)?.classList.add('is-dim'))
    outcome.lit.forEach((id, i) => {
      timers.push(setTimeout(() => svg.querySelector(`[data-node="${id}"]`)?.classList.add('is-lit'), reduce.matches ? 0 : i * 220))
    })
    outcome.links.forEach((id, i) => {
      timers.push(setTimeout(() => {
        const link = svg.querySelector(`[data-link="${id}"]`)
        link?.classList.add('is-lit')
        if (outcome.stop && i === 1) link?.classList.add('is-stop')
      }, reduce.matches ? 0 : 120 + i * 220))
    })
    log.textContent = outcome.log
    buttons.forEach((b) => b.classList.toggle('is-active', b.dataset.outcome === key))
  }

  buttons.forEach((button) => button.addEventListener('click', () => { userSelected = true; show(button.dataset.outcome) }))

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { if (!userSelected) show('not_sent'); io.disconnect() }
  }, { threshold: 0.4 })
  io.observe(root)
}
window.AICanvasSite = Object.assign(window.AICanvasSite ?? {}, { initRuntime })
})()
