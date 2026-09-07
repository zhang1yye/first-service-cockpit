(() => {
  'use strict'

  const RELEASE = 'r65-sidebar-suppressed-labels-20260813-v1'
  let observedSidebar = null
  let sidebarObserver = null

  function syncSuppressedState() {
    const sidebar = document.querySelector('.aph-exact-sidebar')
    const menu = document.querySelector('.aph-header-menu')
    const suppressed = sidebar?.classList.contains('aph-r57-hover-suppressed') === true

    document.documentElement.dataset.r65SidebarRelease = RELEASE
    if (!sidebar) return

    sidebar.toggleAttribute('data-r65-collapsed-suppressed', suppressed)
    const expanded = !suppressed && (
      sidebar.matches(':hover')
      || sidebar.classList.contains('is-hovered')
      || sidebar.classList.contains('is-expanded')
    )
    const nextExpanded = String(expanded)
    if (menu?.getAttribute('aria-expanded') !== nextExpanded) {
      menu?.setAttribute('aria-expanded', nextExpanded)
    }
  }

  function queueStableSync() {
    queueMicrotask(syncSuppressedState)
    window.requestAnimationFrame(syncSuppressedState)
  }

  function bindSidebar() {
    const sidebar = document.querySelector('.aph-exact-sidebar')
    if (sidebar === observedSidebar) {
      syncSuppressedState()
      return
    }
    sidebarObserver?.disconnect()
    observedSidebar = sidebar
    sidebarObserver = null
    if (sidebar) {
      sidebarObserver = new MutationObserver(syncSuppressedState)
      sidebarObserver.observe(sidebar, {
        attributes: true,
        attributeFilter: ['class'],
      })
    }
    syncSuppressedState()
  }

  const shellObserver = new MutationObserver(bindSidebar)
  shellObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindSidebar, { once: true })
  } else {
    bindSidebar()
  }

  document.addEventListener('click', queueStableSync)
  document.addEventListener('keydown', queueStableSync)
  window.addEventListener('click', () => window.setTimeout(syncSuppressedState, 0), true)
  window.addEventListener('keydown', () => window.setTimeout(syncSuppressedState, 0), true)
})()
