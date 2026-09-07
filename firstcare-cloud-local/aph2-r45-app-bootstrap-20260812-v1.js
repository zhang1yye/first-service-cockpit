/* R45：主应用确定性启动器。欠费与系统页先加载真实壳层，再挂载独立业务内容。 */
const RELEASE = 'r45-app-bootstrap-20260812-v1'
const logicalRoute = window.__aphR45InitialRoute || null
const token = localStorage.getItem('cockpit_token')
  || localStorage.getItem('authToken')
  || localStorage.getItem('token')
  || ''

document.documentElement.dataset.r45AppBootstrap = RELEASE

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

function waitForMain(timeout = 15_000) {
  const current = document.getElementById('main-content')
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      observer.disconnect()
      reject(new Error('等待驾驶舱主内容区超时'))
    }, timeout)
    const observer = new MutationObserver(() => {
      const main = document.getElementById('main-content')
      if (!main) return
      window.clearTimeout(timer)
      observer.disconnect()
      resolve(main)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  })
}

function mountIntegrated(main, route) {
  document.body.dataset.aphUnifiedView = route.slice(1)
  document.body.dataset.r45Route = route.slice(1)
  main.dataset.aphUnifiedRoute = route
  main.className = 'aph-unified-main-host'
  main.replaceChildren()

  if (route === '/arrears') {
    const frame = document.createElement('iframe')
    frame.id = 'aph-arrears-frame'
    frame.title = '欠费经营分析业务内容'
    frame.src = '/arrears/index.html?embedded=1&v=r45-cloudfix1'
    frame.loading = 'eager'
    frame.setAttribute('referrerpolicy', 'same-origin')
    main.append(frame)
    document.title = '欠费经营分析 · 第一服务华北地区'
  } else {
    main.innerHTML = systemMarkup()
    document.title = '系统管理 · 第一服务华北地区'
  }

  window.history.replaceState(window.history.state, '', route)
  document.documentElement.dataset.r45IntegratedRoute = route
  window.dispatchEvent(new CustomEvent('aph:r45-integrated-mounted', { detail: { route } }))
}

if (logicalRoute && !token) {
  window.location.replace(`/login?next=${encodeURIComponent(logicalRoute)}`)
} else {
  if (logicalRoute) {
    const backingRoute = logicalRoute === '/arrears' ? '/collection' : '/command'
    window.history.replaceState(window.history.state, '', backingRoute)
  }

  await import('/assets/cockpit-r6-20260810-v1/app-G7HUEEER.js')

  if (logicalRoute) {
    const main = await waitForMain()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    mountIntegrated(main, logicalRoute)
  }
}
