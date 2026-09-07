/* R31：欠费经营与系统管理只替换业务内容区，统一复用驾驶舱顶栏、侧栏和标签栏。 */
(() => {
  'use strict'

  const RELEASE = 'r31-unified-shell-20260812-v14'
  const INTEGRATED_ROUTES = new Set(['/arrears', '/system'])
  const requestedRoute = window.location.pathname.replace(/\/+$/, '') || '/'
  let logicalRoute = INTEGRATED_ROUTES.has(requestedRoute) ? requestedRoute : null
  let scheduled = false

  function browserRoute() {
    return window.location.pathname.replace(/\/+$/, '') || '/'
  }

  function currentRoute() {
    return logicalRoute || browserRoute()
  }

  function canonicalizeShellLinks(root = document) {
    root.querySelectorAll('a[href]').forEach((link) => {
      const label = (link.textContent || '').replace(/\s+/g, ' ').trim()
      const target = new URL(link.href, window.location.origin)

      const bindIntegratedLink = (route) => {
        link.href = route
        link.dataset.aphExactHref = route
        if (link.dataset.aphUnifiedRouteBound === '1') return
        link.addEventListener('click', (event) => {
          if (
            event.button !== 0
            || event.metaKey
            || event.ctrlKey
            || event.shiftKey
            || event.altKey
          ) return
          event.preventDefault()
          event.stopImmediatePropagation()
          enterIntegratedRoute(route)
        }, true)
        link.dataset.aphUnifiedRouteBound = '1'
      }

      if (label.includes('欠费经营分析')) {
        bindIntegratedLink('/arrears')
        return
      }

      if (label.includes('系统管理') || label === '数据管理') {
        const isShellNavigation = Boolean(link.closest('.aph-exact-sidebar, .aph-page-tabs, header'))
        if (isShellNavigation && (target.pathname === '/system/' || target.pathname === '/admin' || target.pathname === '/admin/')) {
          bindIntegratedLink('/system')
        }
      }
    })
  }

  function systemMarkup() {
    return `
      <section class="aph-system-hub" aria-labelledby="aph-system-title">
        <header class="aph-system-intro">
          <div>
            <span class="aph-system-eyebrow">SYSTEM MANAGEMENT</span>
            <h1 id="aph-system-title">系统管理</h1>
            <p>业务使用与后台维护分开进入。日常查看、分析和处置留在驾驶舱；数据源、账号、规则和审计只在后台管理。</p>
          </div>
          <span class="aph-system-readonly">业务端只读</span>
        </header>
        <div class="aph-system-entry-grid" aria-label="系统入口">
          <a class="aph-system-entry is-usage" href="/">
            <div class="aph-system-entry-head"><span class="aph-system-entry-icon">01</span><span>USAGE PORTAL</span></div>
            <div><h2>使用界面</h2><p>面向全员的经营驾驶舱，按账号授权展示片区、项目和服务中心数据。</p></div>
            <ul><li>首页总览、经营分析与异常预警</li><li>回款、收缴率、项目和月报只读查询</li><li>不开放数据源、账号和口径配置</li></ul>
            <strong>进入使用界面 <b>→</b></strong>
          </a>
          <a class="aph-system-entry is-admin" href="/admin">
            <div class="aph-system-entry-head"><span class="aph-system-entry-icon">02</span><span>ADMIN CONSOLE</span></div>
            <div><h2>后台管理界面</h2><p>仅限系统管理员，用于管理数据源、项目映射、指标规则、账号权限、发布状态和审计记录。</p></div>
            <ul><li>管理员登录后才能进入和执行操作</li><li>所有变更保留操作审计</li><li>业务数据查看与后台配置彼此隔离</li></ul>
            <strong>进入后台管理 <b>→</b></strong>
          </a>
        </div>
        <aside class="aph-system-note"><b>权限边界</b><span>使用界面遵循账号数据范围；后台管理需要管理员身份。两类入口共用驾驶舱壳层，但操作权限严格分离。</span></aside>
      </section>`
  }

  function mountIntegratedRoute() {
    scheduled = false
    canonicalizeShellLinks()
    const route = currentRoute()
    if (!INTEGRATED_ROUTES.has(route)) {
      delete document.body.dataset.aphUnifiedView
      return
    }

    const main = document.getElementById('main-content')
    if (!main) return scheduleMount()
    if (logicalRoute && browserRoute() !== logicalRoute) {
      originalReplaceState(window.history.state, '', logicalRoute)
    }
    document.title = route === '/arrears'
      ? '欠费经营分析 · 第一服务华北地区'
      : '系统管理 · 第一服务华北地区'
    const hasMountedContent = route === '/arrears'
      ? Boolean(main.querySelector('#aph-arrears-frame'))
      : Boolean(main.querySelector('.aph-system-hub'))
    if (main.dataset.aphUnifiedRoute === route && hasMountedContent) return

    document.body.dataset.aphUnifiedView = route.slice(1)
    main.dataset.aphUnifiedRoute = route
    main.className = 'aph-unified-main-host'
    main.replaceChildren()

    if (route === '/arrears') {
      const frame = document.createElement('iframe')
      frame.id = 'aph-arrears-frame'
      frame.title = '欠费经营分析业务内容'
      // 明确指向业务页文件，避免 Nginx/SPA 将 /arrears/ 再次回退到驾驶舱首页并形成递归套壳。
      frame.src = '/arrears/index.html?embedded=1&v=r35-home-palette1'
      frame.loading = 'eager'
      frame.setAttribute('referrerpolicy', 'same-origin')
      main.append(frame)
      return
    }

    main.innerHTML = systemMarkup()
  }

  function scheduleMount() {
    if (scheduled) return
    scheduled = true
    window.setTimeout(mountIntegratedRoute, 24)
  }

  function normalizeHistoryArgs(args) {
    const nextArgs = [...args]
    if (nextArgs[2] === undefined || nextArgs[2] === null || nextArgs[2] === '') return nextArgs
    const target = new URL(String(nextArgs[2]), window.location.origin)
    if (target.origin !== window.location.origin) return nextArgs
    if (target.pathname === '/collection' && target.searchParams.get('view') === 'arrears') {
      nextArgs[2] = `/arrears${target.hash}`
    } else if (target.pathname === '/arrears/') {
      nextArgs[2] = `/arrears${target.search}${target.hash}`
    } else if (target.pathname === '/system/') {
      nextArgs[2] = `/system${target.search}${target.hash}`
    }
    const targetRoute = target.pathname.replace(/\/+$/, '') || '/'
    const isBackingShellRoute = (
      (logicalRoute === '/arrears' && targetRoute === '/collection')
      || (logicalRoute === '/system' && targetRoute === '/command')
    )
    if (logicalRoute && !INTEGRATED_ROUTES.has(targetRoute) && !isBackingShellRoute) {
      logicalRoute = null
      delete document.body.dataset.aphUnifiedView
      const main = document.getElementById('main-content')
      if (main) {
        delete main.dataset.aphUnifiedRoute
        main.classList.remove('aph-unified-main-host')
      }
    }
    return nextArgs
  }

  function enterIntegratedRoute(route) {
    if (!INTEGRATED_ROUTES.has(route)) return
    logicalRoute = route
    document.documentElement.dataset.aphLastIntegratedRoute = route
    originalPushState(window.history.state, '', route)
    canonicalizeShellLinks()
    mountIntegratedRoute()
  }

  const originalPushState = window.history.pushState.bind(window.history)
  const originalReplaceState = window.history.replaceState.bind(window.history)
  if (logicalRoute) {
    const shellRoute = logicalRoute === '/arrears' ? '/collection' : '/command'
    originalReplaceState(window.history.state, '', shellRoute)
  }
  window.history.pushState = (...args) => {
    const result = originalPushState(...normalizeHistoryArgs(args))
    scheduleMount()
    return result
  }
  window.history.replaceState = (...args) => {
    const result = originalReplaceState(...normalizeHistoryArgs(args))
    scheduleMount()
    return result
  }

  window.addEventListener('click', (event) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!anchor) return
    const target = new URL(anchor.href, window.location.origin)
    if (target.origin !== window.location.origin) return
    const targetRoute = target.pathname.replace(/\/+$/, '') || '/'
    if (!INTEGRATED_ROUTES.has(targetRoute) || targetRoute === currentRoute()) return
    event.preventDefault()
    event.stopImmediatePropagation()
    enterIntegratedRoute(targetRoute)
  }, true)

  window.addEventListener('aph:integrated-navigation', (event) => {
    const route = String(event.detail?.route || '').replace(/\/+$/, '') || '/'
    enterIntegratedRoute(route)
  })

  window.addEventListener('popstate', scheduleMount)
  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!anchor) return
    const target = new URL(anchor.href, window.location.origin)
    if (target.origin !== window.location.origin) return
    const targetRoute = target.pathname.replace(/\/+$/, '') || '/'

    if (INTEGRATED_ROUTES.has(targetRoute)) {
      if (targetRoute === currentRoute()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      enterIntegratedRoute(targetRoute)
      return
    }

    if (!INTEGRATED_ROUTES.has(currentRoute()) || targetRoute === currentRoute()) return
    event.preventDefault()
    event.stopImmediatePropagation()
    window.location.assign(`${target.pathname}${target.search}${target.hash}`)
  }, true)

  const observer = new MutationObserver(() => {
    canonicalizeShellLinks()
    scheduleMount()
  })
  const start = () => {
    const root = document.getElementById('root')
    if (root) observer.observe(root, { childList: true, subtree: true })
    canonicalizeShellLinks()
    scheduleMount()
  }

  document.documentElement.dataset.aphUnifiedShell = RELEASE
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
