(() => {
  'use strict'

  const RELEASE = 'r8-home-layout-20260810-v1'
  const ROLE_CLASSES = [
    'r8-home-core',
    'r8-home-budget',
    'r8-home-collection',
    'r8-home-period',
    'r8-home-growth',
    'r8-home-target',
    'r8-home-scope',
  ]
  let scheduled = false

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim()

  function setRole(node, role) {
    ROLE_CLASSES.forEach(className => node.classList.remove(className))
    node.classList.add(role)
  }

  function markDuplicate(node, reason) {
    if (!node) return
    node.classList.add('r8-home-duplicate')
    node.dataset.r8Duplicate = reason
    node.hidden = true
    node.setAttribute('aria-hidden', 'true')
  }

  function classifyCard(node) {
    const text = normalize(node.textContent)
    if (text.includes('核心指标') && text.includes('累计执行')) return 'r8-home-core'
    if (text.includes('年度预算') && text.includes('年度完成率') && text.includes('累计差额')) return 'r8-home-budget'
    if (text.includes('应收总额') && text.includes('实收总额') && text.includes('收缴率')) return 'r8-home-collection'
    if (text.includes('同期执行')) return 'r8-home-period'
    if (text.includes('增幅')) return 'r8-home-growth'
    if (text.includes('经营分组') || text.includes('服务中心数')) return 'r8-home-scope'
    if (text.includes('距年度目标')) return 'r8-home-target'
    return ''
  }

  function refineBudget(card) {
    const duplicate = [...card.children].find(node => {
      const text = normalize(node.textContent)
      return text.includes('年度预算') && !text.includes('年度完成率') && !text.includes('累计差额')
    })
    markDuplicate(duplicate, 'annual-budget')
  }

  function refineCollection(card) {
    const details = [...card.querySelectorAll('div')].find(node => {
      const text = normalize(node.textContent)
      return node.classList.contains('flex-1') && node.classList.contains('text-sm')
        && text.includes('应收总额') && text.includes('实收总额')
    })
    if (details) {
      details.classList.add('r8-home-collection-details')
      const rows = [...details.children]
      const rateRow = rows.find(node => normalize(node.textContent).startsWith('收缴率'))
      const progressRow = rows.find(node => normalize(node.textContent).includes('收缴进度'))
      markDuplicate(rateRow, 'collection-rate-detail')
      markDuplicate(progressRow, 'collection-progress')
      details.parentElement?.classList.add('r8-home-collection-body')
    }

    const ringLayer = card.querySelector('.absolute.inset-0')
    ringLayer?.parentElement?.classList.add('r8-home-rate-ring')
  }

  function applyHomeLayout() {
    if (window.location.pathname !== '/') return
    const root = document.querySelector('#main-content .aph-home-reflow')
    const grid = root?.querySelector(':scope > .aph-home-kpi-grid')
    if (!root || !grid) return

    root.dataset.r8HomeLayout = RELEASE
    ;[...grid.children].forEach(card => {
      const role = classifyCard(card)
      if (!role) return
      setRole(card, role)
      if (role === 'r8-home-budget') refineBudget(card)
      if (role === 'r8-home-collection') refineCollection(card)
      if (role === 'r8-home-target') markDuplicate(card, 'distance-to-target')
    })
    document.body?.setAttribute('data-r8-home-layout', RELEASE)
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(() => {
      scheduled = false
      applyHomeLayout()
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
