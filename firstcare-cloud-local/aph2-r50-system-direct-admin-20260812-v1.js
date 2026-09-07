/* R50：取消“系统管理”中转页，所有旧入口单向收口到后台管理。 */
(() => {
  'use strict'

  const RELEASE = 'r50-system-direct-admin-20260812-v1'
  const ADMIN_ROUTE = '/admin'
  const OPEN_TABS_KEY = 'aph-open-tabs-v1'
  const LOGIN_NEXT_KEY = 'aph-r50-login-next'
  const SPA_ROUTES = new Set([
    '/command',
    '/payment',
    '/collection',
    '/daily',
    '/projects',
    '/import',
    '/ai-report',
    '/ai-alerts',
    '/tasks',
    '/review',
    '/arrears',
    '/admin',
    '/login',
  ])
  const SYSTEM_PATHS = new Set(['/system', '/system/', '/system/index.html'])
  const FULL_PAGE_ROUTES = new Map([
    ['/system', ADMIN_ROUTE],
    ['/system/', ADMIN_ROUTE],
    ['/system/index.html', ADMIN_ROUTE],
    ['/admin/', ADMIN_ROUTE],
    ['/admin/index.html', ADMIN_ROUTE],
    ['/review-system', '/review?view=workbench'],
    ['/review-system/', '/review?view=workbench'],
  ])
  const LEGACY_ROUTES = new Map([
    ['/arrears/', '/arrears'],
    ['/arrears/index.html', '/arrears'],
    ['/alerts', '/ai-alerts'],
    ['/alerts/', '/ai-alerts'],
    ['/report', '/ai-report'],
    ['/report/', '/ai-report'],
  ])

  function targetWithSuffix(target, source = window.location) {
    const next = new URL(target, window.location.origin)
    if (!next.search && source.search) next.search = source.search
    if (!next.hash && source.hash) next.hash = source.hash
    return `${next.pathname}${next.search}${next.hash}`
  }

  function adminTarget(source) {
    return targetWithSuffix(ADMIN_ROUTE, source)
  }

  function hasSessionToken() {
    return Boolean(
      window.localStorage.getItem('cockpit_token')
      || window.localStorage.getItem('authToken')
      || window.localStorage.getItem('token')
    )
  }

  function adminLoginTarget(target = ADMIN_ROUTE) {
    return `/login?next=${encodeURIComponent(target)}`
  }

  function requestedAdminReturn() {
    if (window.location.pathname !== '/login') return ''
    const requested = new URLSearchParams(window.location.search).get('next')
    if (!requested) return ''
    try {
      const target = new URL(requested, window.location.origin)
      if (target.origin !== window.location.origin) return ''
      if (!SYSTEM_PATHS.has(target.pathname) && target.pathname !== ADMIN_ROUTE && target.pathname !== '/admin/') {
        return ''
      }
      target.pathname = ADMIN_ROUTE
      return `${target.pathname}${target.search}${target.hash}`
    } catch {
      return ''
    }
  }

  function captureLoginReturn() {
    const target = requestedAdminReturn()
    if (target) window.sessionStorage.setItem(LOGIN_NEXT_KEY, target)
  }

  function resumeLoginReturn() {
    if (window.location.pathname === '/login' || !hasSessionToken()) return false
    const target = window.sessionStorage.getItem(LOGIN_NEXT_KEY)
    if (!target) return false
    window.sessionStorage.removeItem(LOGIN_NEXT_KEY)
    try {
      const user = JSON.parse(window.localStorage.getItem('cockpit_user') || '{}')
      if (user.role !== 'admin' || window.location.pathname === ADMIN_ROUTE) return false
    } catch {
      return false
    }
    window.location.replace(target)
    return true
  }

  function normalizeInitialRoute() {
    const { pathname } = window.location
    if (SYSTEM_PATHS.has(pathname)) {
      const admin = adminTarget(window.location)
      const target = hasSessionToken() ? admin : adminLoginTarget(admin)
      document.documentElement.dataset.aphSystemRedirect = 'admin'
      document.documentElement.style.visibility = 'hidden'
      window.history.replaceState(window.history.state, '', admin)
      window.location.replace(target)
      return true
    }

    if (pathname === ADMIN_ROUTE && !hasSessionToken()) {
      const target = adminTarget(window.location)
      window.location.replace(adminLoginTarget(target))
      return true
    }

    if (pathname === '/collection' && new URLSearchParams(window.location.search).get('view') === 'arrears') {
      window.location.replace('/arrears')
      return true
    }

    const mappedTarget = FULL_PAGE_ROUTES.get(pathname) || LEGACY_ROUTES.get(pathname)
    if (mappedTarget && targetWithSuffix(mappedTarget) !== targetWithSuffix(pathname)) {
      window.location.replace(targetWithSuffix(mappedTarget))
      return true
    }

    if (pathname.length > 1 && pathname.endsWith('/')) {
      const canonical = pathname.replace(/\/+$/, '')
      const isProjectDetail = /^\/projects\/\d+$/.test(canonical)
      if (SPA_ROUTES.has(canonical) || isProjectDetail) {
        window.location.replace(targetWithSuffix(canonical))
        return true
      }
    }
    return false
  }

  function normalizeTabHref(href) {
    if (typeof href !== 'string' || !href.startsWith('/')) return href
    const target = new URL(href, window.location.origin)
    if (SYSTEM_PATHS.has(target.pathname) || target.pathname === '/admin/') {
      target.pathname = ADMIN_ROUTE
      return `${target.pathname}${target.search}${target.hash}`
    }
    return href
  }

  function normalizeOpenTabs() {
    try {
      const raw = window.sessionStorage.getItem(OPEN_TABS_KEY)
      if (!raw) return
      const stored = JSON.parse(raw)
      if (!Array.isArray(stored)) return
      const seen = new Set()
      const normalized = stored.reduce((items, item) => {
        if (!item || typeof item.href !== 'string') return items
        const next = { ...item, href: normalizeTabHref(item.href) }
        if (seen.has(next.href)) return items
        seen.add(next.href)
        items.push(next)
        return items
      }, [])
      const nextRaw = JSON.stringify(normalized)
      if (nextRaw !== raw) window.sessionStorage.setItem(OPEN_TABS_KEY, nextRaw)
    } catch {
      // 会话页签异常不影响主路由，保持现有页面继续工作。
    }
  }

  function normalizeAdminLink(link) {
    const href = link.getAttribute('href')
    if (href) {
      try {
        const target = new URL(href, window.location.origin)
        if (target.origin === window.location.origin && SYSTEM_PATHS.has(target.pathname)) {
          target.pathname = ADMIN_ROUTE
          link.setAttribute('href', `${target.pathname}${target.search}${target.hash}`)
        }
      } catch {
        // 非标准 href 交由浏览器原生处理。
      }
    }

    const tabHref = link.getAttribute('data-aph-tab-href')
    const normalizedTabHref = normalizeTabHref(tabHref)
    if (normalizedTabHref && normalizedTabHref !== tabHref) {
      link.setAttribute('data-aph-tab-href', normalizedTabHref)
    }
  }

  function refreshAdminLinks(root = document) {
    if (root instanceof Element && root.matches('a[href],a[data-aph-tab-href]')) {
      normalizeAdminLink(root)
    }
    root.querySelectorAll?.('a[href],a[data-aph-tab-href]').forEach(normalizeAdminLink)
    normalizeOpenTabs()
  }

  function bindHardNavigation() {
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

      const mappedTarget = FULL_PAGE_ROUTES.get(target.pathname) || LEGACY_ROUTES.get(target.pathname)
      if (!mappedTarget) return

      event.preventDefault()
      event.stopImmediatePropagation()
      window.location.assign(targetWithSuffix(mappedTarget, target))
    }, true)
  }

  function observeNavigation() {
    refreshAdminLinks(document)
    const root = document.getElementById('root')
    if (root) {
      new MutationObserver((records) => {
        records.forEach(record => record.addedNodes.forEach(node => {
          if (node instanceof Element) refreshAdminLinks(node)
        }))
        normalizeOpenTabs()
      }).observe(root, { childList: true, subtree: true })
    }
    window.addEventListener('popstate', () => refreshAdminLinks(document))
    window.addEventListener('cockpit:navigation', () => refreshAdminLinks(document))
  }

  document.documentElement.dataset.aphSystemDirectAdmin = RELEASE
  bindHardNavigation()
  captureLoginReturn()
  if (resumeLoginReturn()) return
  if (normalizeInitialRoute()) return
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeNavigation, { once: true })
  } else {
    observeNavigation()
  }
})()
