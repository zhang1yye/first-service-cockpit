/* 欠费经营分析复用驾驶舱主壳层；旧页面只作为无壳业务内容载体。 */
(() => {
  'use strict'

  const RELEASE = 'r30-arrears-integrated-20260811-v1'
  const ROUTE = '/collection'
  const VIEW = 'arrears'
  let scheduled = false

  function isArrearsRoute() {
    return window.location.pathname.replace(/\/+$/, '') === ROUTE
      && new URLSearchParams(window.location.search).get('view') === VIEW
  }

  function mountArrears() {
    scheduled = false
    if (!isArrearsRoute()) {
      delete document.body.dataset.aphArrearsIntegrated
      return
    }

    const main = document.getElementById('main-content')
    if (!main) return scheduleMount()
    if (main.querySelector('#aph-arrears-frame')) return

    document.body.dataset.aphArrearsIntegrated = '1'
    document.title = '欠费经营分析 · 第一服务华北地区'
    main.className = 'aph-arrears-main-host'
    main.replaceChildren()

    const frame = document.createElement('iframe')
    frame.id = 'aph-arrears-frame'
    frame.title = '欠费经营分析业务内容'
    frame.src = '/arrears/?embedded=1'
    frame.loading = 'eager'
    frame.setAttribute('referrerpolicy', 'same-origin')
    main.append(frame)
  }

  function scheduleMount() {
    if (scheduled) return
    scheduled = true
    window.setTimeout(mountArrears, 24)
  }

  const originalPushState = window.history.pushState.bind(window.history)
  const originalReplaceState = window.history.replaceState.bind(window.history)
  window.history.pushState = (...args) => {
    const result = originalPushState(...args)
    scheduleMount()
    return result
  }
  window.history.replaceState = (...args) => {
    const result = originalReplaceState(...args)
    scheduleMount()
    return result
  }

  window.addEventListener('popstate', scheduleMount)
  document.addEventListener('click', (event) => {
    if (!isArrearsRoute() || event.defaultPrevented || event.button !== 0) return
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!anchor) return
    const target = new URL(anchor.href, window.location.origin)
    if (target.origin !== window.location.origin) return
    if (target.pathname.replace(/\/+$/, '') === ROUTE && target.searchParams.get('view') === VIEW) return
    event.preventDefault()
    event.stopImmediatePropagation()
    window.location.assign(`${target.pathname}${target.search}${target.hash}`)
  }, true)

  const observer = new MutationObserver(scheduleMount)
  const start = () => {
    const root = document.getElementById('root')
    if (root) observer.observe(root, { childList: true, subtree: true })
    scheduleMount()
  }

  document.documentElement.dataset.aphArrearsIntegration = RELEASE
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
