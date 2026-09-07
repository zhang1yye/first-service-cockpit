(() => {
  'use strict'

  const RELEASE = 'r45-global-accessibility-20260812-v1'
  const SCROLL_ROUTES = new Set(['/ai-alerts', '/import', '/review'])
  let scheduled = false
  let started = false

  function setReleaseScope() {
    document.body?.setAttribute('data-r45-global-a11y', RELEASE)
  }

  function syncAssistantOverlay() {
    document.querySelectorAll('.north-ai-overlay').forEach(overlay => {
      const concealed = overlay.getAttribute('aria-hidden') === 'true'
      overlay.inert = concealed
      overlay.toggleAttribute('inert', concealed)
      overlay.dataset.r45A11y = 'assistant-overlay'
    })
  }

  function normalizePageTabs() {
    document.querySelectorAll('.aph-tab-list').forEach(tabList => {
      tabList.setAttribute('role', 'navigation')
      tabList.setAttribute('aria-label', tabList.getAttribute('aria-label') || '已打开页面')
      tabList.dataset.r45A11y = 'page-navigation'

      tabList.querySelectorAll('.aph-route-tab').forEach(tab => {
        tab.removeAttribute('role')
      })
      tabList.querySelectorAll('a[data-aph-tab-href]').forEach(link => {
        link.removeAttribute('role')
        link.removeAttribute('aria-selected')
        const current = link.closest('.aph-route-tab')?.classList.contains('is-active')
        link.toggleAttribute('aria-current', Boolean(current))
        if (current) link.setAttribute('aria-current', 'page')
      })
    })
  }

  function normalizeReviewSwitcher() {
    document.querySelectorAll('.aph-review-workbench-switch[data-review-workbench-mode]').forEach(switcher => {
      switcher.setAttribute('role', 'group')
      switcher.dataset.r45A11y = 'review-view-group'

      switcher.querySelectorAll(':scope > button[data-review-mode]').forEach(button => {
        if (button.hasAttribute('aria-selected')) {
          button.setAttribute('aria-pressed', button.getAttribute('aria-selected') === 'true' ? 'true' : 'false')
        }
        button.removeAttribute('role')
        button.removeAttribute('aria-selected')
      })
    })
  }

  function normalizeHomeMap() {
    const map = document.querySelector('svg[aria-label="辽宁、河北、天津、北京区域地图"]')
    if (!map) return
    map.setAttribute('role', 'group')
    map.dataset.r45A11y = 'region-map'
  }

  function nearestHeadingText(region, main) {
    const section = region.closest('section, article, .card-soft')
    const localHeading = section?.querySelector('h1, h2, h3, h4')
    if (localHeading?.textContent?.trim()) return localHeading.textContent.trim()

    let sibling = region.previousElementSibling
    while (sibling) {
      if (sibling.matches('h1, h2, h3, h4') && sibling.textContent?.trim()) return sibling.textContent.trim()
      const nestedHeading = sibling.querySelector?.('h1, h2, h3, h4')
      if (nestedHeading?.textContent?.trim()) return nestedHeading.textContent.trim()
      sibling = sibling.previousElementSibling
    }
    return main.querySelector('h1, h2')?.textContent?.trim() || ''
  }

  function isScrollable(region) {
    const style = window.getComputedStyle(region)
    const scrollsY = /auto|scroll/.test(style.overflowY) && region.scrollHeight > region.clientHeight + 1
    const scrollsX = /auto|scroll/.test(style.overflowX) && region.scrollWidth > region.clientWidth + 1
    return scrollsY || scrollsX
  }

  function enhanceScrollableRegions() {
    const route = window.location.pathname
    if (!SCROLL_ROUTES.has(route)) return
    const main = document.querySelector('main#main-content, main')
    if (!main) return

    main.querySelectorAll('.table-scroll, .overflow-auto, [class*="overflow-auto"], [class*="overflow-x-auto"], [class*="overflow-y-auto"]').forEach(region => {
      if (!(region instanceof HTMLElement)) return
      const reviewTaskRegion = route === '/review'
        && Boolean(region.closest('[data-review-task-priority]'))
      if (!reviewTaskRegion && !isScrollable(region)) return
      region.tabIndex = 0
      region.setAttribute('role', 'region')
      const label = nearestHeadingText(region, main)
      if (label && !region.getAttribute('aria-label') && !region.getAttribute('aria-labelledby')) {
        region.setAttribute('aria-label', label)
      }
      region.dataset.r45A11y = 'scroll-region'
    })
  }

  function apply() {
    scheduled = false
    setReleaseScope()
    syncAssistantOverlay()
    normalizePageTabs()
    normalizeReviewSwitcher()
    normalizeHomeMap()
    enhanceScrollableRegions()
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(apply)
  }

  function start() {
    if (started) return
    started = true
    schedule()
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'aria-selected'],
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('popstate', schedule)
    window.addEventListener('cockpit:navigation', schedule)
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  if (document.readyState !== 'loading') start()
})()
