(() => {
  'use strict'

  const RELEASE = 'r57-sidebar-overlay-20260812-v1'
  const PIN_KEY = 'aph-nav-pinned-v2'
  let lastPath = window.location.pathname
  let suppressedPath = null
  let linkSuppression = false

  window.sessionStorage.removeItem(PIN_KEY)
  document.documentElement.dataset.r57SidebarRelease = RELEASE

  function elements() {
    return {
      sidebar: document.querySelector('.aph-exact-sidebar'),
      menu: document.querySelector('.aph-header-menu'),
    }
  }

  function closeOverlay({ focusMenu = false, clearHover = false, suppressUntilLeave = false } = {}) {
    const { sidebar, menu } = elements()
    if (!sidebar) return
    sidebar.classList.remove('is-expanded')
    if (clearHover) sidebar.classList.remove('is-hovered')
    if (suppressUntilLeave) {
      suppressedPath = window.location.pathname
      sidebar.classList.add('aph-r57-hover-suppressed')
    }
    window.sessionStorage.removeItem(PIN_KEY)
    menu?.setAttribute(
      'aria-expanded',
      String(!sidebar.classList.contains('aph-r57-hover-suppressed') && sidebar.classList.contains('is-hovered')),
    )
    if (focusMenu) menu?.focus()
  }

  function normalize() {
    const { sidebar, menu } = elements()
    if (!sidebar) return
    if (sidebar.dataset.r57OverlayReady !== '1') {
      sidebar.dataset.r57OverlayReady = '1'
      closeOverlay({ clearHover: true })
    }
    if (sidebar.dataset.r57LeaveBound !== '1') {
      sidebar.dataset.r57LeaveBound = '1'
      sidebar.addEventListener('mouseleave', () => {
        sidebar.classList.remove('aph-r57-hover-suppressed')
        suppressedPath = null
        linkSuppression = false
      })
    }
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname
      if (suppressedPath !== lastPath) linkSuppression = false
      closeOverlay({ clearHover: true, suppressUntilLeave: true })
    }
    if (suppressedPath === window.location.pathname) {
      sidebar.classList.add('aph-r57-hover-suppressed')
      if (!linkSuppression && !sidebar.matches(':hover')) {
        sidebar.classList.remove('aph-r57-hover-suppressed')
        suppressedPath = null
      }
    }
    window.sessionStorage.removeItem(PIN_KEY)
    if (menu) menu.setAttribute('aria-label', '展开或收起主导航')
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null
    const menu = target?.closest('.aph-header-menu')
    const { sidebar } = elements()
    if (menu && sidebar) {
      event.preventDefault()
      event.stopImmediatePropagation()
      sidebar.classList.remove('aph-r57-hover-suppressed')
      suppressedPath = null
      linkSuppression = false
      const expanded = sidebar.classList.toggle('is-expanded')
      window.sessionStorage.removeItem(PIN_KEY)
      menu.setAttribute('aria-expanded', String(expanded || sidebar.classList.contains('is-hovered')))
      return
    }
    const navLink = target?.closest('.aph-exact-sidebar a[href]')
    if (navLink) {
      suppressedPath = new URL(navLink.href, window.location.href).pathname
      linkSuppression = true
      sidebar?.classList.add('aph-r57-hover-suppressed')
      closeOverlay({ clearHover: true })
      return
    }
    if (sidebar?.classList.contains('is-expanded') && !target?.closest('.aph-exact-sidebar')) {
      closeOverlay()
    }
  }, true)

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    linkSuppression = false
    closeOverlay({ focusMenu: true, clearHover: true, suppressUntilLeave: true })
  })

  window.addEventListener('pagehide', () => window.sessionStorage.removeItem(PIN_KEY))

  const observer = new MutationObserver(() => normalize())
  observer.observe(document.documentElement, { childList: true, subtree: true })
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', normalize, { once: true })
  else normalize()
})()
