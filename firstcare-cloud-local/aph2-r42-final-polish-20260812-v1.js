(() => {
  'use strict'

  const RELEASE = 'r42-final-polish-20260812-v1'
  const MOBILE_BREAKPOINT = 640
  const IMPORT_VISIBLE_COUNT = 3
  const ADMIN_VISIBLE_COUNT = 10
  let scheduled = false
  let importExpanded = false
  let adminExpanded = false

  const routeName = pathname => {
    if (pathname === '/') return 'home'
    return pathname.replace(/^\//, '').split('/')[0] || 'home'
  }

  const directButtons = element => [...element.children]
    .filter(child => child instanceof HTMLButtonElement)

  function setRouteScope() {
    document.body?.setAttribute('data-r42-route', routeName(window.location.pathname))
    document.body?.setAttribute('data-r42-release', RELEASE)
  }

  function toggleButton({ host, className, expanded, hiddenCount, onClick, noun }) {
    let button = host.querySelector(`:scope > .${className}`)
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = `aph-r42-expand ${className}`
      button.addEventListener('click', onClick)
      host.append(button)
    }
    button.setAttribute('aria-expanded', String(expanded))
    button.textContent = expanded ? `收起${noun}` : `显示其余 ${hiddenCount} ${noun}`
    return button
  }

  function enhanceImportBatches() {
    if (window.location.pathname !== '/import') return
    const section = document.querySelector('section[data-p46-pipeline="true"]')
    const list = section?.querySelector(':scope > .space-y-3')
    if (!section || !list) return
    list.classList.add('aph-r42-import-batches')
    const batches = [...list.children].filter(child => child instanceof HTMLElement)
    const mobile = window.innerWidth <= MOBILE_BREAKPOINT
    batches.forEach((batch, index) => {
      batch.classList.add('aph-r42-import-batch')
      batch.hidden = mobile && !importExpanded && index >= IMPORT_VISIBLE_COUNT
    })
    const hiddenCount = Math.max(0, batches.length - IMPORT_VISIBLE_COUNT)
    const existing = section.querySelector(':scope > .aph-r42-import-toggle')
    if (!mobile || hiddenCount === 0) {
      existing?.remove()
      return
    }
    toggleButton({
      host: section,
      className: 'aph-r42-import-toggle',
      expanded: importExpanded,
      hiddenCount,
      noun: '批次',
      onClick: () => {
        importExpanded = !importExpanded
        schedule()
      },
    })
  }

  function enhanceAdminTabs() {
    if (window.location.pathname !== '/admin') return
    const expected = ['回款额', '收缴率', '月度趋势', '预警规则', '操作日志', '月报归档', '数据源接入', '用户管理']
    const tablist = [...document.querySelectorAll('#root div')].find(element => {
      const labels = directButtons(element).map(button => button.textContent?.trim())
      return expected.every(label => labels.includes(label))
    })
    if (!tablist) return
    tablist.classList.add('aph-r42-admin-tabs')
    tablist.setAttribute('role', 'tablist')
    tablist.setAttribute('aria-label', '后台业务域')
    directButtons(tablist).forEach(button => {
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', String(button.classList.contains('bg-primary')))
    })
  }

  function enhanceAdminTable() {
    if (window.location.pathname !== '/admin') return
    document.querySelectorAll('table').forEach(table => {
      const rows = [...table.querySelectorAll('tbody tr')]
      if (!rows.length) return
      const host = table.parentElement
      const safetyToolbar = table.querySelector('tbody > .aph-admin-safety-toolbar')
      if (host && safetyToolbar) host.insertBefore(safetyToolbar, table)
      rows.forEach(row => {
        const lastCell = row.lastElementChild
        if (lastCell instanceof HTMLTableCellElement) {
          lastCell.dataset.r34Label = '操作'
          lastCell.setAttribute('data-r34-label', '操作')
        }
      })

      const mobile = window.innerWidth <= MOBILE_BREAKPOINT
      rows.forEach((row, index) => {
        row.hidden = mobile && !adminExpanded && index >= ADMIN_VISIBLE_COUNT
      })
      const hiddenCount = Math.max(0, rows.length - ADMIN_VISIBLE_COUNT)
      const existing = host?.querySelector(':scope > .aph-r42-admin-toggle')
      if (!host || !mobile || hiddenCount === 0) {
        existing?.remove()
        return
      }
      toggleButton({
        host,
        className: 'aph-r42-admin-toggle',
        expanded: adminExpanded,
        hiddenCount,
        noun: '行',
        onClick: () => {
          adminExpanded = !adminExpanded
          schedule()
        },
      })
    })
  }

  function apply() {
    scheduled = false
    setRouteScope()
    enhanceImportBatches()
    enhanceAdminTabs()
    enhanceAdminTable()
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
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  if (document.readyState !== 'loading') start()
})()
