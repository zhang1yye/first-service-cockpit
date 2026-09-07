(() => {
  'use strict'

  const RELEASE = 'r79-home-layout-stability-20260814-v1'
  const R8_RELEASE = 'r8-home-layout-20260810-v1'
  const ROLE_CLASSES = [
    'r8-home-core',
    'r8-home-budget',
    'r8-home-collection',
    'r8-home-period',
    'r8-home-growth',
    'r8-home-target',
    'r8-home-scope',
  ]
  const RETRY_DELAYS = [0, 16, 50, 100, 250, 500, 1000, 2000]
  let frame = 0
  let observer = null

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim()

  function findHomeParts() {
    if (window.location.pathname !== '/') return null
    const main = document.querySelector('#main-content')
    if (!main) return null

    const roots = [main, ...main.children]
    for (const root of roots) {
      const sections = [...root.children].filter(node => node.tagName === 'SECTION')
      const banner = sections.find(node => node.classList.contains('aph-business-banner'))
      const grid = sections.find(node => {
        const text = normalize(node.textContent)
        return node !== banner && text.includes('核心指标') && text.includes('累计执行')
      })
      if (!banner || !grid) continue
      return {
        root,
        banner,
        grid,
        following: sections.filter(node => node !== banner && node !== grid),
      }
    }
    return null
  }

  function setRole(node, role) {
    for (const className of ROLE_CLASSES) {
      if (className !== role && node.classList.contains(className)) node.classList.remove(className)
    }
    if (!node.classList.contains(role)) node.classList.add(role)
  }

  function markDuplicate(node, reason) {
    if (!node) return
    if (!node.classList.contains('r8-home-duplicate')) node.classList.add('r8-home-duplicate')
    if (node.dataset.r8Duplicate !== reason) node.dataset.r8Duplicate = reason
    if (!node.hidden) node.hidden = true
    if (node.getAttribute('aria-hidden') !== 'true') node.setAttribute('aria-hidden', 'true')
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
      if (!details.classList.contains('r8-home-collection-details')) details.classList.add('r8-home-collection-details')
      const rows = [...details.children]
      markDuplicate(rows.find(node => normalize(node.textContent).startsWith('收缴率')), 'collection-rate-detail')
      markDuplicate(rows.find(node => normalize(node.textContent).includes('收缴进度')), 'collection-progress')
      if (details.parentElement && !details.parentElement.classList.contains('r8-home-collection-body')) {
        details.parentElement.classList.add('r8-home-collection-body')
      }
    }

    const ring = card.querySelector('.absolute.inset-0')?.parentElement
    if (ring && !ring.classList.contains('r8-home-rate-ring')) ring.classList.add('r8-home-rate-ring')
  }

  function apply() {
    const parts = findHomeParts()
    if (!parts) return false
    const { root, banner, grid, following } = parts

    if (!root.classList.contains('aph-home-reflow')) root.classList.add('aph-home-reflow')
    if (!banner.classList.contains('aph-home-visual')) banner.classList.add('aph-home-visual')
    if (!grid.classList.contains('aph-home-kpi-grid')) grid.classList.add('aph-home-kpi-grid')
    if (following[0] && !following[0].classList.contains('aph-home-region-grid')) following[0].classList.add('aph-home-region-grid')
    if (following[1] && !following[1].classList.contains('aph-home-ranking-grid')) following[1].classList.add('aph-home-ranking-grid')

    let classified = 0
    for (const card of grid.children) {
      const role = classifyCard(card)
      if (!role) continue
      classified += 1
      setRole(card, role)
      if (role === 'r8-home-budget') refineBudget(card)
      if (role === 'r8-home-collection') refineCollection(card)
      if (role === 'r8-home-target') markDuplicate(card, 'distance-to-target')
    }
    if (classified < 6) return false

    if (root.dataset.r8HomeLayout !== R8_RELEASE) root.dataset.r8HomeLayout = R8_RELEASE
    if (root.dataset.r79HomeLayout !== RELEASE) root.dataset.r79HomeLayout = RELEASE
    if (document.body?.getAttribute('data-r8-home-layout') !== R8_RELEASE) {
      document.body?.setAttribute('data-r8-home-layout', R8_RELEASE)
    }
    document.documentElement.dataset.r79HomeLayout = RELEASE
    return true
  }

  function schedule() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      apply()
    })
  }

  function retry() {
    for (const delay of RETRY_DELAYS) window.setTimeout(schedule, delay)
  }

  function start() {
    retry()
    if (!observer) {
      observer = new MutationObserver(schedule)
      observer.observe(document.getElementById('root') || document.documentElement, { childList: true, subtree: true })
    }
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  window.addEventListener('pageshow', retry)
  window.addEventListener('popstate', retry)
  window.addEventListener('cockpit:navigation', retry)
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link && new URL(link.href, location.href).origin === location.origin) window.setTimeout(retry, 0)
  }, true)
  if (document.readyState !== 'loading') start()
})()
