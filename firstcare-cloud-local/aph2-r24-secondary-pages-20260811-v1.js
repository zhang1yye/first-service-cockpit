(() => {
  'use strict'

  const RELEASE = 'r24-secondary-pages-20260811-v1'
  const ROUTE_CLASSES = [
    'aph-r24-command',
    'aph-r24-projects',
    'aph-r24-ai-alerts',
    'aph-r24-ai-report',
    'aph-r24-review',
  ]
  let scheduled = false

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim()

  function setRouteClass() {
    const path = window.location.pathname
    const routeClass = path === '/command' ? 'aph-r24-command'
      : path === '/projects' ? 'aph-r24-projects'
        : path === '/ai-alerts' ? 'aph-r24-ai-alerts'
          : path === '/ai-report' ? 'aph-r24-ai-report'
            : path === '/review' ? 'aph-r24-review'
              : ''

    ROUTE_CLASSES.forEach(className => document.body?.classList.remove(className))
    if (routeClass) document.body?.classList.add(routeClass)
    document.body?.setAttribute('data-r24-secondary-pages', RELEASE)
  }

  function enhanceCommand(main) {
    if (window.location.pathname !== '/command') return
    const overview = [...main.querySelectorAll('section')].find(section => {
      const text = normalize(section.textContent)
      return text.includes('今日经营判断') && text.includes('下一步操作')
    })
    if (!overview) return

    overview.classList.add('aph-r24-command-overview')
    const actionHeading = [...overview.querySelectorAll('*')]
      .find(node => !node.children.length && normalize(node.textContent) === '下一步操作')
    const actionPanel = actionHeading?.closest('.card-soft')
    actionPanel?.classList.add('aph-r24-command-actions')

    const decisionCard = overview.firstElementChild
    const kpis = [...(decisionCard?.querySelectorAll(':scope > div') || [])].find(node => {
      const text = normalize(node.textContent)
      return text.includes('累计完成率') && text.includes('累计差额') && text.includes('未达标中心')
    })
    kpis?.classList.add('aph-r24-command-kpis')
  }

  function enhanceAlerts(main) {
    if (window.location.pathname !== '/ai-alerts') return

    const overallHeading = [...main.querySelectorAll('h2,h3,h4')]
      .find(node => normalize(node.textContent) === 'AI 总体判断')
    const overallCard = overallHeading?.closest('.card-soft')
    if (overallCard && /预警未生成[。.]?$/.test(normalize(overallCard.textContent))) {
      overallCard.classList.add('aph-r24-redundant-empty')
      overallCard.setAttribute('aria-hidden', 'true')
    }

    const sourceHeading = [...main.querySelectorAll('h2,h3,h4,span,strong')]
      .find(node => normalize(node.textContent) === '数据源同步预警')
    const sourceCard = sourceHeading?.closest('.card-soft')
    sourceCard?.classList.add('aph-r24-alert-source-card')
    const sourceGrid = sourceCard?.querySelector('.grid')
    if (sourceGrid?.children.length === 1) sourceGrid.classList.add('aph-r24-single-source')

    const emptyTable = [...main.querySelectorAll('.table-card')]
      .find(node => normalize(node.textContent).includes('当前筛选条件下暂无预警'))
    emptyTable?.classList.add('aph-r24-alert-empty-table')
  }

  function enhanceReport(main) {
    if (window.location.pathname !== '/ai-report') return
    const layout = main.querySelector(':scope > .mx-auto')
    if (!layout) return
    layout.classList.add('aph-r24-report-layout')

    ;[...layout.children].forEach(child => {
      const text = normalize(child.textContent)
      if (text.includes('真实性门禁阻断') && child.querySelector('button') && !child.querySelector('.aph-gate-empty')) {
        child.classList.add('aph-r24-redundant-alert')
        child.setAttribute('aria-hidden', 'true')
      }
      if (text.includes('领导版') && text.includes('经营版')) child.classList.add('aph-r24-report-mode-actions')
      if (text.includes('片区筛选') && text.includes('打印/导出PDF')) child.classList.add('aph-r24-report-filter-actions')
      if (text.includes('项目经营事实未发布，月报未生成')) child.classList.add('aph-r24-report-empty')
    })
  }

  function apply() {
    setRouteClass()
    const main = document.getElementById('main-content')
    if (!main) return
    enhanceCommand(main)
    enhanceAlerts(main)
    enhanceReport(main)
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(() => {
      scheduled = false
      apply()
    })
  }

  function start() {
    schedule()
    new MutationObserver(schedule).observe(
      document.getElementById('root') || document.documentElement,
      { childList: true, subtree: true },
    )
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  window.addEventListener('popstate', schedule)
  window.addEventListener('cockpit:navigation', schedule)
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link && new URL(link.href, location.href).origin === location.origin) window.setTimeout(schedule, 0)
  }, true)
  if (document.readyState !== 'loading') start()
})()
