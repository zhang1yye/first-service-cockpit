(() => {
  'use strict'

  const RELEASE = 'r70-sidebar-transient-overlay-20260813-v1'
  const SUPPRESSED = 'aph-r70-hover-suppressed'
  const PIN_KEY = 'aph-nav-pinned-v2'
  let observedSidebar = null
  let sidebarObserver = null
  let observedMenu = null
  let menuObserver = null
  let pointer = { x: -1, y: -1, seen: false }
  let initialHoverPending = true
  let suppressionActive = false
  let pointerMenuOpen = false
  let pointerMenuEntered = false
  let pointerMenuTimer = 0
  let initialHoverFrame = 0
  let lastMenuPointerType = ''

  document.documentElement.dataset.r70SidebarRelease = RELEASE

  function elements() {
    return {
      sidebar: document.querySelector('.aph-exact-sidebar'),
      panel: document.querySelector('.aph-exact-sidebar-panel'),
      menu: document.querySelector('.aph-header-menu'),
    }
  }

  function desktop() {
    return window.matchMedia('(min-width: 641px)').matches
  }

  function setClass(node, token, enabled) {
    if (!node || node.classList.contains(token) === enabled) return
    node.classList.toggle(token, enabled)
  }

  function pointerInPanel(panel) {
    if (!panel || !pointer.seen) return false
    const rect = panel.getBoundingClientRect()
    return pointer.x >= rect.left && pointer.x < rect.right
      && pointer.y >= rect.top && pointer.y < rect.bottom
  }

  function syncAria() {
    const { sidebar, menu } = elements()
    if (!desktop() || !sidebar || !menu) return
    const expanded = !suppressionActive && (
      sidebar.classList.contains('is-hovered')
      || sidebar.classList.contains('is-expanded')
      || sidebar.matches(':hover')
    )
    const next = String(expanded)
    if (menu.getAttribute('aria-expanded') !== next) menu.setAttribute('aria-expanded', next)
  }

  function collapse({ suppressHover = false, focusMenu = false } = {}) {
    if (!desktop()) return
    const { sidebar, menu } = elements()
    if (!sidebar) return
    window.clearTimeout(pointerMenuTimer)
    pointerMenuTimer = 0
    pointerMenuOpen = false
    pointerMenuEntered = false
    setClass(sidebar, 'is-expanded', false)
    setClass(sidebar, 'is-hovered', false)
    if (suppressHover) suppressionActive = true
    setClass(sidebar, SUPPRESSED, suppressionActive)
    window.sessionStorage.removeItem(PIN_KEY)
    syncAria()
    if (focusMenu) menu?.focus()
  }

  function releaseSuppression() {
    if (!suppressionActive) return
    suppressionActive = false
    initialHoverPending = false
    const { sidebar } = elements()
    setClass(sidebar, SUPPRESSED, false)
    syncAria()
  }

  function detectInitialHover() {
    if (!desktop() || !initialHoverPending || initialHoverFrame) return
    const probe = () => {
      initialHoverFrame = 0
      const { sidebar } = elements()
      if (!sidebar || !initialHoverPending) return
      if (sidebar.matches(':hover')) {
        initialHoverPending = false
        suppressionActive = true
        collapse({ suppressHover: true })
        return
      }
      initialHoverFrame = window.requestAnimationFrame(() => {
        initialHoverFrame = 0
        const current = elements().sidebar
        initialHoverPending = false
        if (current?.matches(':hover')) {
          suppressionActive = true
          collapse({ suppressHover: true })
        }
      })
    }
    initialHoverFrame = window.requestAnimationFrame(probe)
  }

  function bindSidebar() {
    const { sidebar, panel, menu } = elements()
    if (!desktop()) {
      sidebarObserver?.disconnect()
      sidebarObserver = null
      observedSidebar = null
      menuObserver?.disconnect()
      menuObserver = null
      observedMenu = null
      setClass(sidebar, SUPPRESSED, false)
      return
    }
    if (!sidebar) return

    if (sidebar !== observedSidebar) {
      sidebarObserver?.disconnect()
      observedSidebar = sidebar
      sidebarObserver = new MutationObserver(() => {
        if (suppressionActive) {
          setClass(sidebar, 'is-expanded', false)
          setClass(sidebar, 'is-hovered', false)
          setClass(sidebar, SUPPRESSED, true)
        }
        syncAria()
      })
      sidebarObserver.observe(sidebar, { attributes: true, attributeFilter: ['class'] })
    }

    if (menu !== observedMenu) {
      menuObserver?.disconnect()
      observedMenu = menu
      menuObserver = null
      if (menu) {
        menuObserver = new MutationObserver(() => syncAria())
        menuObserver.observe(menu, { attributes: true, attributeFilter: ['aria-expanded'] })
      }
    }

    if (initialHoverPending) {
      if (sidebar.matches(':hover')) {
        initialHoverPending = false
        suppressionActive = true
      } else {
        detectInitialHover()
      }
    }
    if (suppressionActive) collapse({ suppressHover: true })
    else setClass(sidebar, SUPPRESSED, false)

    if (pointer.seen && !pointerInPanel(panel)) releaseSuppression()
    syncAria()
  }

  window.addEventListener('pointermove', event => {
    if (!desktop()) return
    pointer = { x: event.clientX, y: event.clientY, seen: true }
    const { panel } = elements()
    if (pointerMenuOpen) {
      if (pointerInPanel(panel)) {
        pointerMenuEntered = true
        window.clearTimeout(pointerMenuTimer)
        pointerMenuTimer = 0
      } else if (pointerMenuEntered) {
        collapse()
      }
    }
    if (suppressionActive && !pointerInPanel(panel)) releaseSuppression()
  }, true)

  window.addEventListener('pointerdown', event => {
    if (!desktop()) return
    const target = event.target instanceof Element ? event.target : null
    lastMenuPointerType = target?.closest('.aph-header-menu') ? event.pointerType : ''
  }, true)

  // R57 在 document capture 阶段会截断汉堡点击；window capture 可先观察本次意图。
  window.addEventListener('click', event => {
    if (!desktop()) return
    const target = event.target instanceof Element ? event.target : null
    const menu = target?.closest('.aph-header-menu')
    if (menu) {
      const pointerActivation = event.detail > 0 && lastMenuPointerType === 'mouse'
      lastMenuPointerType = ''
      window.setTimeout(() => {
        const { sidebar, panel } = elements()
        if (sidebar?.classList.contains('is-expanded')) {
          suppressionActive = false
          setClass(sidebar, SUPPRESSED, false)
          if (pointerActivation) {
            pointerMenuOpen = true
            pointerMenuEntered = pointerInPanel(panel)
            window.clearTimeout(pointerMenuTimer)
            pointerMenuTimer = window.setTimeout(() => {
              if (pointerMenuOpen && !pointerMenuEntered) collapse()
            }, 1200)
          } else {
            sidebar.querySelector('a[href]')?.focus()
          }
          syncAria()
        } else {
          collapse()
        }
      }, 0)
      return
    }

    if (target?.closest('.aph-exact-sidebar a[href]')) {
      suppressionActive = true
      initialHoverPending = false
      collapse({ suppressHover: true })
      return
    }

    if (!target?.closest('.aph-exact-sidebar')) collapse()
  }, true)

  document.addEventListener('keydown', event => {
    if (!desktop() || event.key !== 'Escape') return
    suppressionActive = true
    initialHoverPending = false
    collapse({ suppressHover: true, focusMenu: true })
  })

  const shellObserver = new MutationObserver(bindSidebar)
  shellObserver.observe(document.documentElement, { childList: true, subtree: true })
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindSidebar, { once: true })
  } else {
    bindSidebar()
  }
  window.matchMedia('(min-width: 641px)').addEventListener('change', () => {
    const { sidebar } = elements()
    window.cancelAnimationFrame(initialHoverFrame)
    initialHoverFrame = 0
    window.clearTimeout(pointerMenuTimer)
    pointerMenuTimer = 0
    pointerMenuOpen = false
    pointerMenuEntered = false
    lastMenuPointerType = ''
    suppressionActive = false
    initialHoverPending = desktop()
    setClass(sidebar, 'is-expanded', false)
    setClass(sidebar, 'is-hovered', false)
    setClass(sidebar, SUPPRESSED, false)
    window.sessionStorage.removeItem(PIN_KEY)
    bindSidebar()
  })
})()
