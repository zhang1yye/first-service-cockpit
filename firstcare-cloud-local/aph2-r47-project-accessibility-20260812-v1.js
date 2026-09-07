(() => {
  'use strict'

  const RELEASE = 'r47-project-accessibility-20260812-v1'
  const DIALOG_ID = 'aph-r47-project-dialog'
  const DIALOG_TITLE_ID = 'aph-r47-project-dialog-title'
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')

  let scheduled = false
  let activeDrawer = null
  let lastProjectOpener = null

  function isVisible(element) {
    return element instanceof HTMLElement
      && !element.hidden
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden'
  }

  function projectDrawer() {
    return document.querySelector('.aph-project-drawer')
  }

  function dialogPanel(drawer) {
    return drawer?.querySelector('.aph-project-drawer-panel') || null
  }

  function focusableElements(panel) {
    return [...panel.querySelectorAll(FOCUSABLE)].filter(isVisible)
  }

  function restoreProjectOpener() {
    const opener = lastProjectOpener
    lastProjectOpener = null
    if (!(opener instanceof HTMLElement) || !opener.isConnected) return
    window.requestAnimationFrame(() => opener.focus({ preventScroll: true }))
  }

  function closeProjectDrawer(drawer) {
    const panel = dialogPanel(drawer)
    const close = panel?.querySelector('[data-project-drawer-close]')
      || drawer?.querySelector('[data-project-drawer-close]')
    if (close instanceof HTMLElement) close.click()
    else if (drawer) drawer.hidden = true
  }

  function nameProjectDialog(panel) {
    panel.id = DIALOG_ID
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', panel.getAttribute('aria-label') || '项目档案详情')
    panel.tabIndex = -1

    const heading = panel.querySelector('h2')
    if (heading) {
      heading.id = DIALOG_TITLE_ID
      panel.setAttribute('aria-labelledby', DIALOG_TITLE_ID)
    } else {
      panel.removeAttribute('aria-labelledby')
    }
  }

  function syncProjectDrawer(drawer) {
    const panel = dialogPanel(drawer)
    if (!drawer || !panel) return
    nameProjectDialog(panel)
    const mask = drawer.querySelector('.aph-project-drawer-mask')
    if (mask instanceof HTMLElement) {
      mask.tabIndex = -1
      mask.setAttribute('aria-hidden', 'true')
    }

    if (drawer.hidden) {
      if (drawer.dataset.r47Open === 'true') {
        drawer.dataset.r47Open = 'false'
        document.body.classList.remove('aph-r47-project-dialog-open')
        activeDrawer = null
        restoreProjectOpener()
      }
      return
    }

    if (drawer.dataset.r47Open !== 'true') {
      drawer.dataset.r47Open = 'true'
      document.body.classList.add('aph-r47-project-dialog-open')
      activeDrawer = drawer
      window.requestAnimationFrame(() => {
        if (drawer.hidden || !panel.isConnected) return
        const firstControl = focusableElements(panel)[0]
        ;(firstControl || panel).focus({ preventScroll: true })
      })
      return
    }

    if (document.activeElement === panel) {
      const firstControl = focusableElements(panel)[0]
      if (firstControl) window.requestAnimationFrame(() => firstControl.focus({ preventScroll: true }))
    }
  }

  function enhanceProjectRows() {
    if (window.location.pathname !== '/projects') return
    document.querySelectorAll('[data-project-profile-id]').forEach(row => {
      row.setAttribute('aria-haspopup', 'dialog')
      row.setAttribute('aria-controls', DIALOG_ID)
      row.dataset.r47Action = 'dialog'
    })
  }

  function enhanceProjectStatusAndTable() {
    if (window.location.pathname !== '/projects') return
    document.querySelectorAll('[data-project-visible-count]').forEach(count => {
      count.setAttribute('role', 'status')
      count.setAttribute('aria-live', 'polite')
      count.setAttribute('aria-atomic', 'true')
    })
    document.querySelectorAll('.aph-project-table-wrap').forEach(region => {
      region.setAttribute('role', 'region')
      if (!region.hasAttribute('aria-label')) region.setAttribute('aria-label', '项目档案表格')
    })
  }

  function enhanceSkipLink() {
    document.querySelectorAll('a.skip-link[href="#main-content"]').forEach(skip => {
      if (skip.dataset.r47SkipBound === 'true') return
      skip.dataset.r47SkipBound = 'true'
      skip.addEventListener('click', event => {
        const main = document.getElementById('main-content')
        if (!main) return
        event.preventDefault()
        if (!main.hasAttribute('tabindex')) main.tabIndex = -1
        main.focus({ preventScroll: true })
        main.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        })
      })
    })
  }

  function orderMobileNavigationBeforeContent() {
    const nav = document.querySelector('.aph-mobile-primary-nav')
    if (!nav) return
    if (!window.matchMedia('(max-width: 640px)').matches) {
      if (nav.dataset.r47DomOrder === 'before-content') {
        const drawer = document.querySelector('.aph-mobile-more-drawer')
        document.body.insertBefore(nav, drawer || null)
        delete nav.dataset.r47DomOrder
      }
      return
    }
    const main = document.getElementById('main-content')
    const contentShell = main?.parentElement
    if (!main || !contentShell) return
    if (nav.parentElement !== contentShell || nav.nextSibling !== main) {
      contentShell.insertBefore(nav, main)
    }
    nav.dataset.r47DomOrder = 'before-content'
  }

  function apply() {
    scheduled = false
    document.body?.setAttribute('data-r47-release', RELEASE)
    enhanceSkipLink()
    orderMobileNavigationBeforeContent()

    if (activeDrawer && !activeDrawer.isConnected) {
      activeDrawer = null
      document.body.classList.remove('aph-r47-project-dialog-open')
      restoreProjectOpener()
    }

    if (window.location.pathname !== '/projects') return
    enhanceProjectRows()
    enhanceProjectStatusAndTable()
    const drawer = projectDrawer()
    if (drawer) syncProjectDrawer(drawer)
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(apply)
  }

  function bindInteractionSafety() {
    if (document.documentElement.dataset.r47InteractionBound === 'true') return
    document.documentElement.dataset.r47InteractionBound = 'true'

    document.addEventListener('click', event => {
      const row = event.target instanceof Element
        ? event.target.closest('[data-project-profile-id]')
        : null
      if (row instanceof HTMLElement) lastProjectOpener = row
    }, true)

    document.addEventListener('keydown', event => {
      const drawer = activeDrawer || projectDrawer()
      if (drawer && !drawer.hidden) {
        const panel = dialogPanel(drawer)
        if (!panel) return

        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeProjectDrawer(drawer)
          return
        }

        if (event.key === 'Tab') {
          const controls = focusableElements(panel)
          if (!controls.length) {
            event.preventDefault()
            panel.focus({ preventScroll: true })
            return
          }
          const first = controls[0]
          const last = controls[controls.length - 1]
          const outside = !panel.contains(document.activeElement)
          if (event.shiftKey && (outside || document.activeElement === first)) {
            event.preventDefault()
            last.focus({ preventScroll: true })
          } else if (!event.shiftKey && (outside || document.activeElement === last)) {
            event.preventDefault()
            first.focus({ preventScroll: true })
          }
          return
        }
      }

      const row = event.target instanceof Element
        ? event.target.closest('[data-project-profile-id]')
        : null
      if (row instanceof HTMLElement && (event.key === 'Enter' || event.key === ' ')) {
        lastProjectOpener = row
      }
    }, true)
  }

  function start() {
    bindInteractionSafety()
    schedule()
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('popstate', schedule)
    window.addEventListener('cockpit:navigation', schedule)
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  if (document.readyState !== 'loading') start()
})()
