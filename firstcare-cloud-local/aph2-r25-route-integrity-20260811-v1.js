/* 统一驾驶舱 SPA、独立管理页和历史入口的导航边界，避免有效页面落入站内 404。 */
(() => {
  'use strict'

  const RELEASE = 'r25-route-integrity-20260811-v1'
  const SYSTEM_HUB = '/system/'
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
    '/login',
  ])
  const STANDALONE_ROUTES = new Map([
    ['/system', '/system/'],
    ['/system/', '/system/'],
    ['/admin', '/admin/'],
    ['/admin/', '/admin/'],
    ['/arrears', '/arrears/'],
    ['/arrears/', '/arrears/'],
    ['/review-system', '/review-system/'],
    ['/review-system/', '/review-system/'],
  ])
  const LEGACY_ROUTES = new Map([
    ['/alerts', '/ai-alerts'],
    ['/alerts/', '/ai-alerts'],
    ['/report', '/ai-report'],
    ['/report/', '/ai-report'],
  ])

  function targetWithSuffix(pathname, source = window.location) {
    return `${pathname}${source.search || ''}${source.hash || ''}`
  }

  function normalizeInitialRoute() {
    const pathname = window.location.pathname
    const legacyTarget = LEGACY_ROUTES.get(pathname)
    if (legacyTarget) {
      window.location.replace(targetWithSuffix(legacyTarget))
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

  function refreshSystemLinks(root = document) {
    root.querySelectorAll('a[href="/admin"],a[href="/admin/"]').forEach((link) => {
      const text = (link.textContent || '').trim()
      const label = link.getAttribute('aria-label') || link.getAttribute('title') || ''
      if (!text.includes('数据管理') && !text.includes('系统管理') && !label.includes('系统管理')) return
      link.href = SYSTEM_HUB
      link.removeAttribute('aria-current')
      const leaf = [...link.querySelectorAll('span')]
        .find((node) => ['数据管理', '系统管理'].includes(node.textContent.trim()))
      if (leaf) leaf.textContent = '系统管理'
    })
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

      const standaloneTarget = STANDALONE_ROUTES.get(target.pathname)
      const legacyTarget = LEGACY_ROUTES.get(target.pathname)
      const nextPath = standaloneTarget || legacyTarget
      if (!nextPath) return

      event.preventDefault()
      event.stopImmediatePropagation()
      window.location.assign(targetWithSuffix(nextPath, target))
    }, true)
  }

  function observeNavigation() {
    refreshSystemLinks(document)
    const root = document.querySelector('#root')
    if (root) {
      new MutationObserver(() => refreshSystemLinks(root))
        .observe(root, { childList: true, subtree: true })
    }

    let remaining = 16
    const apply = () => {
      refreshSystemLinks(document)
      remaining -= 1
      if (remaining > 0) window.setTimeout(apply, 180)
    }
    apply()
  }

  document.documentElement.dataset.aphRouteIntegrity = RELEASE
  bindHardNavigation()
  if (normalizeInitialRoute()) return
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeNavigation, { once: true })
  } else {
    observeNavigation()
  }
})()
