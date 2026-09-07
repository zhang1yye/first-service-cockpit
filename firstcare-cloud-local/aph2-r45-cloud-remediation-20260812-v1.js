/* R45：云端全量复验收口。路由身份、真实性门禁预检、语义与触控增强。 */
(() => {
  'use strict'

  const RELEASE = 'r45-cloud-remediation-20260812-v1'
  const PROTECTED_AI_ENDPOINTS = [
    '/api/ai/trends',
    '/api/ai/risk-trends',
    '/api/ai/ask',
    '/api/ai/interpret',
    '/api/ai/health',
    '/api/ai/project',
    '/api/alerts',
    '/api/ai/monthly-report',
    '/api/ai/brief',
    '/api/ai/week-focus',
  ]
  const INTEGRATED_ROUTES = new Set(['/arrears'])
  const initialRoute = window.location.pathname.replace(/\/+$/, '') || '/'
  const nativeFetch = window.fetch.bind(window)
  let gatePromise = null
  let scheduled = false

  window.__aphR45InitialRoute = INTEGRATED_ROUTES.has(initialRoute) ? initialRoute : null
  document.documentElement.dataset.r45Release = RELEASE
  document.documentElement.dataset.r45InitialRoute = initialRoute

  function requestPath(input) {
    try {
      const candidate = typeof input === 'string' || input instanceof URL ? input : input?.url
      return new URL(String(candidate || ''), window.location.origin).pathname
    } catch {
      return ''
    }
  }

  function isProtectedAiPath(pathname) {
    return PROTECTED_AI_ENDPOINTS.some(endpoint => (
      pathname === endpoint || pathname.startsWith(`${endpoint}/`)
    ))
  }

  function gateHeaders(input, init = {}) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value))
    if (!headers.has('Authorization')) {
      const token = localStorage.getItem('cockpit_token')
        || localStorage.getItem('authToken')
        || localStorage.getItem('token')
        || ''
      if (token) headers.set('Authorization', `Bearer ${token}`)
    }
    return headers
  }

  async function readProjectGate(input, init) {
    if (!gatePromise) {
      gatePromise = nativeFetch('/api/data-quality/project-gate', {
        method: 'GET',
        headers: gateHeaders(input, init),
        credentials: 'same-origin',
        cache: 'no-store',
      }).then(async response => {
        if (!response.ok) throw new Error(`project gate ${response.status}`)
        return response.json()
      }).catch(() => null)
    }
    return gatePromise
  }

  window.fetch = async (input, init = {}) => {
    const pathname = requestPath(input)
    if (!isProtectedAiPath(pathname)) return nativeFetch(input, init)

    const gate = await readProjectGate(input, init)
    if (!gate || gate.ready) return nativeFetch(input, init)

    const payload = {
      error: '项目经营数据尚未通过真实性门禁',
      code: 'PROJECT_DATA_QUALITY_BLOCKED',
      dataQuality: gate,
    }
    window.__aphProjectGateBlocked = payload
    window.__aphAlertsBlocked = payload
    window.__aphMonthlyReportBlocked = payload
    window.dispatchEvent(new CustomEvent('aph:project-gate', { detail: payload }))
    schedule()
    return new Response(JSON.stringify(payload), {
      status: 409,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-aph-gate-preflight': RELEASE,
      },
    })
  }

  function logicalPathname() {
    const integrated = window.__aphR45InitialRoute
    if (integrated && document.body?.dataset.aphUnifiedView) return integrated
    return window.location.pathname
  }

  function routeName(pathname) {
    if (pathname === '/') return 'home'
    return pathname.replace(/^\//, '').split('/')[0] || 'home'
  }

  function ensureProjectGateNotice() {
    const payload = window.__aphProjectGateBlocked
    if (!payload) return
    const pathname = logicalPathname()
    if (!['/', '/command', '/projects', '/ai-alerts', '/ai-report'].includes(pathname)) return
    const main = document.getElementById('main-content')
    if (!main || main.querySelector(':scope > .aph-r45-project-gate')) return
    const notice = document.createElement('section')
    notice.className = 'aph-r45-project-gate'
    notice.setAttribute('role', 'status')
    notice.setAttribute('aria-live', 'polite')
    const reason = payload.dataQuality?.reasons?.join('；') || payload.error
    notice.innerHTML = '<strong>项目经营分析未生成</strong><p></p><a href="/import">查看数据接入状态</a>'
    notice.querySelector('p').textContent = `${reason}。回款、收缴等已发布事实仍可查看，AI不会把未知状态显示为0。`
    const first = main.firstElementChild
    if (first) main.insertBefore(notice, first)
    else main.append(notice)
  }

  function enhanceAdminLandmark() {
    if (logicalPathname() !== '/admin') return
    const main = document.querySelector('#root > [role="main"], #root main')
    const heading = document.querySelector('.aph-r36-admin-heading h1, #root h1')
    if (!main || !heading) return
    heading.id = 'aph-admin-title'
    main.setAttribute('aria-labelledby', heading.id)
    document.title = '后台数据管理 · 第一服务华北地区'
  }

  function enhanceImportIdentity() {
    if (logicalPathname() !== '/import') return
    document.title = '数据导入 · 第一服务华北地区'
    const headings = [...document.querySelectorAll('main h1')]
    if (headings[0]) headings[0].textContent = '数据导入'
    headings.slice(1).forEach(heading => {
      const replacement = document.createElement('h2')
      for (const attribute of heading.attributes) {
        if (attribute.name !== 'data-aph-business-heading') {
          replacement.setAttribute(attribute.name, attribute.value)
        }
      }
      replacement.innerHTML = heading.innerHTML
      heading.replaceWith(replacement)
    })
    document.querySelectorAll('.aph-route-tab a[href="/import"], .aph-route-tab.is-active a').forEach(link => {
      if (new URL(link.href, window.location.origin).pathname === '/import') link.textContent = '数据导入'
    })
  }

  function enhanceIntegratedIdentity() {
    const pathname = logicalPathname()
    if (pathname === '/arrears') document.title = '欠费经营分析 · 第一服务华北地区'
  }

  function enhanceTouchClasses() {
    const pathname = logicalPathname()
    if (pathname === '/projects') {
      document.querySelectorAll('[data-r6-mapping-link], a[href^="/admin/#mappings"], .r6-sort-button')
        .forEach(element => element.classList.add('aph-r45-touch-target'))
    }
    if (pathname === '/payment') {
      document.querySelectorAll('.r6-sort-button').forEach(element => element.classList.add('aph-r45-touch-target'))
    }
    if (pathname === '/import') {
      document.querySelectorAll('main button').forEach(button => {
        if ((button.textContent || '').trim() === '刷新') button.classList.add('aph-r45-touch-action')
      })
    }
    if (pathname === '/review') {
      document.querySelectorAll('button[aria-label^="查看方案："]')
        .forEach(button => button.classList.add('aph-r45-touch-action'))
    }
  }

  function enhanceMapHitAreas() {
    if (logicalPathname() !== '/') return
    document.querySelectorAll('svg [role="button"][aria-label]').forEach(group => {
      if (!(group instanceof SVGGraphicsElement) || group.dataset.r45HitArea === '1') return
      const rect = group.getBoundingClientRect()
      if (rect.width >= 44 && rect.height >= 44) return
      let box
      try { box = group.getBBox() } catch { return }
      if (!box.width || !box.height || !rect.width || !rect.height) return
      const minimumWidth = box.width * (44 / rect.width)
      const minimumHeight = box.height * (44 / rect.height)
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      hit.setAttribute('x', String(box.x - Math.max(0, minimumWidth - box.width) / 2))
      hit.setAttribute('y', String(box.y - Math.max(0, minimumHeight - box.height) / 2))
      hit.setAttribute('width', String(Math.max(box.width, minimumWidth)))
      hit.setAttribute('height', String(Math.max(box.height, minimumHeight)))
      hit.setAttribute('fill', 'transparent')
      hit.setAttribute('pointer-events', 'all')
      hit.setAttribute('aria-hidden', 'true')
      hit.classList.add('aph-r45-hit-area')
      group.insertBefore(hit, group.firstChild)
      group.dataset.r45HitArea = '1'
    })
  }

  function apply() {
    scheduled = false
    if (!document.body) return
    const pathname = logicalPathname()
    document.body.dataset.r45Release = RELEASE
    document.body.dataset.r45Route = routeName(pathname)
    ensureProjectGateNotice()
    enhanceAdminLandmark()
    enhanceImportIdentity()
    enhanceIntegratedIdentity()
    enhanceTouchClasses()
    enhanceMapHitAreas()
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(apply)
  }

  function start() {
    schedule()
    new MutationObserver(schedule).observe(document.getElementById('root') || document.documentElement, {
      childList: true,
      subtree: true,
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('popstate', schedule)
    window.addEventListener('cockpit:navigation', schedule)
    window.addEventListener('aph:project-gate', schedule)
    window.addEventListener('aph:r45-integrated-mounted', schedule)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
