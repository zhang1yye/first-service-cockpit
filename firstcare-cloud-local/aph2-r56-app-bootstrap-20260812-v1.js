/* R56：CSP 安全的确定性启动器。加载服务中心经营分析资产，欠费分析仍按原有集成方式挂载。 */
const RELEASE = 'r56-app-bootstrap-20260812-v1'
const logicalRoute = window.__aphR45InitialRoute || null
const token = localStorage.getItem('cockpit_token')
  || localStorage.getItem('authToken')
  || localStorage.getItem('token')
  || ''

document.documentElement.dataset.r45AppBootstrap = RELEASE

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
  if (route !== '/arrears') throw new Error(`不支持的集成路由：${route}`)
  document.body.dataset.aphUnifiedView = route.slice(1)
  document.body.dataset.r45Route = route.slice(1)
  main.dataset.aphUnifiedRoute = route
  main.className = 'aph-unified-main-host'
  main.replaceChildren()

  const frame = document.createElement('iframe')
  frame.id = 'aph-arrears-frame'
  frame.title = '欠费经营分析业务内容'
  frame.src = '/arrears/index.html?embedded=1&v=r45-cloudfix1'
  frame.loading = 'eager'
  frame.setAttribute('referrerpolicy', 'same-origin')
  main.append(frame)
  document.title = '欠费经营分析 · 第一服务华北地区'

  window.history.replaceState(window.history.state, '', route)
  document.documentElement.dataset.r45IntegratedRoute = route
  window.dispatchEvent(new CustomEvent('aph:r45-integrated-mounted', { detail: { route } }))
}

if (logicalRoute && !token) {
  window.location.replace(`/login?next=${encodeURIComponent(logicalRoute)}`)
} else {
  if (logicalRoute) {
    window.history.replaceState(window.history.state, '', '/collection')
  }

  await import('/assets/cockpit-r56-ai-service-center-20260812-v1/app-G7HUEEER.js')

  if (logicalRoute) {
    const main = await waitForMain()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    mountIntegrated(main, logicalRoute)
  }
}
