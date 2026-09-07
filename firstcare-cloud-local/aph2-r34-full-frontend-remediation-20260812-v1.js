(() => {
  'use strict'

  const RELEASE = 'r34-full-frontend-remediation-20260812-v1'
  const COLLECTION_RESET_DELAYS = [0, 120, 420, 900]
  let scheduled = false
  let previousLocation = ''
  let scrollTimers = []

  const routeName = pathname => {
    if (pathname === '/') return 'home'
    return pathname.replace(/^\//, '').split('/')[0] || 'home'
  }

  function setRouteScope() {
    document.body?.setAttribute('data-r34-route', routeName(window.location.pathname))
    document.body?.setAttribute('data-r34-release', RELEASE)
  }

  function normalizeShellHeading() {
    const businessHeading = [...document.querySelectorAll('main h1:not(.north-ai-sr-only), #main-content h1:not(.north-ai-sr-only)')]
      .find(heading => heading.getClientRects().length > 0)
    document.querySelectorAll('header h1').forEach(heading => {
      if (!businessHeading && heading.getClientRects().length > 0) return
      const replacement = document.createElement('div')
      replacement.className = heading.className
      replacement.textContent = heading.textContent
      replacement.dataset.aphShellTitle = 'true'
      heading.replaceWith(replacement)
    })
    if (businessHeading || document.querySelector('header h1')) return
    const shellTitle = [...document.querySelectorAll('header [data-aph-shell-title="true"]')]
      .find(candidate => candidate.getClientRects().length > 0)
    if (!shellTitle) return
    const heading = document.createElement('h1')
    heading.className = shellTitle.className
    heading.textContent = shellTitle.textContent
    heading.dataset.aphShellTitle = 'true'
    shellTitle.replaceWith(heading)
  }

  function ensureCollectionHeading() {
    if (window.location.pathname !== '/collection') return
    const existing = [...document.querySelectorAll('#main-content h1')]
      .find(heading => heading.getClientRects().length > 0)
    if (existing) return
    const candidate = [...document.querySelectorAll('#main-content h2, #main-content h3')]
      .find(heading => heading.getClientRects().length > 0 && heading.textContent?.includes('收缴明细'))
    if (!candidate) return
    const heading = document.createElement('h1')
    heading.className = candidate.className
    heading.textContent = candidate.textContent
    heading.dataset.r34PromotedHeading = 'collection'
    candidate.replaceWith(heading)
  }

  function resetScrollPosition() {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
    document.querySelectorAll('#main-content, .aph-unified-main-host').forEach(element => {
      element.scrollTop = 0
      element.scrollLeft = 0
    })
  }

  function scheduleScrollReset(pathname) {
    scrollTimers.forEach(timer => window.clearTimeout(timer))
    const delays = pathname === '/collection' ? COLLECTION_RESET_DELAYS : [0, 120]
    scrollTimers = delays.map(delay => window.setTimeout(resetScrollPosition, delay))
  }

  function addRouteEntrance() {
    const main = document.getElementById('main-content')
    if (!main) return
    main.classList.remove('aph-r34-route-enter')
    window.requestAnimationFrame(() => {
      main.classList.add('aph-r34-route-enter')
      window.setTimeout(() => main.classList.remove('aph-r34-route-enter'), 220)
    })
  }

  function enhanceAdminTables(root = document) {
    if (window.location.pathname !== '/admin') return
    root.querySelectorAll('table').forEach(table => {
      if (table.dataset.r34ResponsiveTable === '1') return
      const labels = [...table.querySelectorAll('thead th')]
        .map((cell, index) => cell.textContent?.replace(/\s+/g, ' ').trim() || `字段 ${index + 1}`)
      table.querySelectorAll('tbody tr').forEach(row => {
        ;[...row.children].forEach((cell, index) => {
          if (!(cell instanceof HTMLTableCellElement)) return
          cell.dataset.r34Label = labels[index] || `字段 ${index + 1}`
          cell.setAttribute('data-r34-label', cell.dataset.r34Label)
        })
      })
      table.dataset.r34ResponsiveTable = '1'
      table.setAttribute('data-r34-responsive-table', '1')
    })
  }

  function collapseTruthCards(root = document) {
    if (!['/arrears', '/ai-alerts'].includes(window.location.pathname)) return
    const cards = [...root.querySelectorAll('[data-aph-truth-state="unavailable"]')]
      .filter(card => !card.closest('.aph-r34-truth-summary'))
    if (cards.length < 3) return
    const first = cards[0]
    const host = first.parentElement
    if (!host || host.querySelector(':scope > .aph-r34-truth-summary')) return

    const summary = document.createElement('section')
    summary.className = 'aph-r34-truth-summary'
    summary.setAttribute('role', 'status')
    summary.innerHTML = '<strong>经营指标待正式批次发布</strong><p>当前仅保留真实性状态、可用数据和下一步操作；未知指标不再逐卡展示。</p>'
    host.insertBefore(summary, first)
    cards.forEach(card => {
      card.hidden = true
      card.dataset.r34CollapsedTruthCard = '1'
      card.setAttribute('data-r34-collapsed-truth-card', '1')
    })
  }

  function enhanceEmbeddedArrears() {
    const frame = document.getElementById('aph-arrears-frame')
    if (!(frame instanceof HTMLIFrameElement)) return
    const enhance = () => {
      try {
        collapseTruthCards(frame.contentDocument || document)
      } catch {}
    }
    if (frame.dataset.r34Bound !== '1') {
      frame.addEventListener('load', enhance)
      frame.dataset.r34Bound = '1'
    }
    enhance()
  }

  function clarifyTasksRoute() {
    if (!['/tasks', '/command'].includes(window.location.pathname)) return
    const main = document.getElementById('main-content')
    if (!main || main.querySelector('.aph-r34-tasks-notice')) return
    const notice = document.createElement('section')
    notice.className = 'aph-r34-tasks-notice'
    notice.innerHTML = '<strong>任务入口已合并至经营工作台</strong><span>经营判断、责任动作和质量事项在同一工作台处理。</span>'
    main.prepend(notice)
  }

  function normalizeUtilityCopy() {
    if (window.location.pathname !== '/command') return
    document.querySelectorAll('#main-content h2').forEach(heading => {
      if (heading.textContent?.includes('先判断经营状态')) heading.textContent = '今日经营判断'
    })
  }

  function apply() {
    scheduled = false
    setRouteScope()
    ensureCollectionHeading()
    normalizeShellHeading()
    enhanceAdminTables()
    collapseTruthCards()
    enhanceEmbeddedArrears()
    clarifyTasksRoute()
    normalizeUtilityCopy()

    const locationKey = `${window.location.pathname}${window.location.search}`
    if (locationKey !== previousLocation) {
      previousLocation = locationKey
      scheduleScrollReset(window.location.pathname)
      addRouteEntrance()
    }
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
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  window.addEventListener('popstate', schedule)
  window.addEventListener('cockpit:navigation', schedule)
  if (document.readyState !== 'loading') start()
})()
