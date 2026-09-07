(() => {
  'use strict'

  const RELEASE = '20260809-remediation3'
  const previousFetch = window.fetch.bind(window)
  const routeTitles = {
    '/': '华北地区经营驾驶舱',
    '/command': '经营工作台',
    '/projects': '项目管理',
    '/payment': '回款额执行',
    '/daily': '每日回款',
    '/collection': '收缴率',
    '/ai-alerts': 'AI预警',
    '/ai-report': 'AI经营月报',
    '/review': '研发审核系统',
    '/admin': '系统管理',
    '/system': '系统管理',
    '/arrears': '欠费经营分析',
  }
  const stateKeys = ['area', 'date', 'tab', 'q', 'sort']
  let queued = false
  let summaryPromise = null
  let reviewOpening = false

  function schedule() {
    if (queued) return
    queued = true
    window.requestAnimationFrame(() => {
      queued = false
      applyRemediation()
    })
  }

  function requestPath(input) {
    try {
      const candidate = typeof input === 'string' ? input : input?.url
      return new URL(String(candidate || ''), window.location.origin).pathname
    } catch {
      return ''
    }
  }

  async function rememberBlockedResponse(response, target) {
    let payload = { status: response.status, code: 'PROJECT_DATA_QUALITY_BLOCKED' }
    try { payload = { ...payload, ...(await response.clone().json()) } } catch { }
    if (target === 'alerts') window.__aphAlertsBlocked = payload
    if (target === 'report') window.__aphMonthlyReportBlocked = payload
    schedule()
  }

  window.fetch = async (input, init = {}) => {
    const pathname = requestPath(input)
    const response = await previousFetch(input, init)
    if (pathname === '/api/alerts') {
      if (response.status === 409) rememberBlockedResponse(response, 'alerts')
      else if (response.ok) window.__aphAlertsBlocked = null
    }
    if (pathname === '/api/ai/monthly-report') {
      if (response.status === 409) rememberBlockedResponse(response, 'report')
      else if (response.ok) window.__aphMonthlyReportBlocked = null
    }
    return response
  }

  function normalizedText(element) {
    return String(element?.textContent || '').replace(/\s+/g, ' ').trim()
  }

  function exactTextElements(root, text) {
    if (!root) return []
    return Array.from(root.querySelectorAll('*')).filter(element => (
      element.children.length === 0 && normalizedText(element) === text
    ))
  }

  function replaceText(root, replacements) {
    if (!root) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    nodes.forEach(node => {
      if (!node.parentElement || ['SCRIPT', 'STYLE', 'TEXTAREA'].includes(node.parentElement.tagName)) return
      let next = String(node.nodeValue || '')
      replacements.forEach(([from, to]) => { next = next.replaceAll(from, to) })
      if (next !== node.nodeValue) node.nodeValue = next
    })
  }

  function metricCard(labelElement, main) {
    let current = labelElement
    while (current && current !== main) {
      const text = normalizedText(current)
      if (current.matches('article,section,[class*="card"],[class*="rounded"]') && text.length < 220) return current
      current = current.parentElement
    }
    return labelElement?.parentElement || null
  }

  function markMetricCardUnknown(card, label) {
    if (!card) return false
    const preferred = card.querySelector('.num,[class*="text-2xl"],[class*="text-3xl"],[class*="text-4xl"]')
    const candidates = preferred
      ? [preferred]
      : Array.from(card.querySelectorAll('strong,b,span,div'))
    const value = candidates.find(element => (
      element.children.length === 0
      && /^[-+]?\d+(?:\.\d+)?(?:%|个|项)?$/.test(normalizedText(element))
    ))
    if (value) value.textContent = '—'
    card.dataset.aphTruthState = 'unavailable'
    card.setAttribute('aria-label', `${label}未生成`)
    card.title = '真实性门禁阻断，当前指标未生成'
    return Boolean(value)
  }

  function setMetricUnknown(main, label) {
    const topGrid = main?.querySelector('.kpi-grid.kpi-grid-5')
    const topCard = Array.from(topGrid?.children || []).find(card => (
      Array.from(card.querySelectorAll('*')).some(element => normalizedText(element) === label)
    ))
    if (topCard && markMetricCardUnknown(topCard, label)) return

    exactTextElements(main, label).some(labelElement => {
      const card = metricCard(labelElement, main)
      return markMetricCardUnknown(card, label)
    })
  }

  function upsertGateNotice(main, className, title, detail, code) {
    if (!main) return null
    let notice = main.querySelector(`.${className}`)
    if (!notice) {
      notice = document.createElement('section')
      notice.className = `aph-truth-gate ${className}`
      notice.setAttribute('role', 'status')
      notice.setAttribute('aria-live', 'polite')
      const host = main.firstElementChild || main
      host.prepend(notice)
    }
    const signature = `${title}|${detail}|${code}`
    if (notice.dataset.signature !== signature) {
      notice.replaceChildren()
      const copy = document.createElement('div')
      const heading = document.createElement('strong')
      const paragraph = document.createElement('p')
      const badge = document.createElement('span')
      heading.textContent = title
      paragraph.textContent = detail
      badge.textContent = code
      copy.append(heading, paragraph)
      notice.append(copy, badge)
      notice.dataset.signature = signature
    }
    return notice
  }

  function enhanceAiAlertsGateState(main, pathname) {
    if (pathname !== '/ai-alerts' || !main || !window.__aphAlertsBlocked) return
    // PROJECT_DATA_QUALITY_BLOCKED 表示无法形成经营判断，不等于风险数量为0。
    ;['预警项目', '高风险', '中风险', 'AI建议动作'].forEach(label => setMetricUnknown(main, label))
    replaceText(main, [
      ['当前暂无预警摘要', '预警未生成'],
      ['暂无预警数据', '预警未生成'],
      ['数据加载失败，请稍后重试', '真实性门禁阻断，预警未生成'],
      ['当前暂无高风险项目', '当前无法判断高风险项目'],
    ])
    const payload = window.__aphAlertsBlocked || {}
    const detail = payload.message || payload.error || '项目经营事实尚未统一发布，暂不能形成经营风险判断；页面不会将未知状态显示为0。'
    upsertGateNotice(main, 'aph-alerts-gate', '预警未生成', detail, '真实性门禁阻断')
  }

  function enhanceAiReportGateState(main, pathname) {
    if (pathname !== '/ai-report' || !main || !window.__aphMonthlyReportBlocked) return
    // PROJECT_DATA_QUALITY_BLOCKED：保留阻断，不伪装成网络失败或“项目数量0”。
    replaceText(main, [
      ['数据加载失败，相关内容暂不可用，请稍后刷新重试', '真实性门禁阻断：项目经营事实尚未统一，月报未生成'],
      ['数据加载失败，请稍后重试', '真实性门禁阻断：项目经营事实尚未统一，月报未生成'],
      ['暂无可生成经营月报的有效项目事实', '项目经营事实未发布，月报未生成'],
      ['AI月报生成失败', '项目经营事实未发布，月报未生成'],
    ])
    ;['事业单元', '项目数量', '本月收入', '本月利润'].forEach(label => setMetricUnknown(main, label))
    const payload = window.__aphMonthlyReportBlocked || {}
    const detail = payload.message || payload.error || '42个项目档案与经营事实映射尚未全部通过发布门禁；归档和正式导出保持禁用。'
    upsertGateNotice(main, 'aph-report-gate', 'AI经营月报未生成', detail, '真实性门禁阻断')
    const disabledLabels = new Set(['归档当前月报', '生成下月任务', '导出Word正式月报', '打印/导出PDF', '导出文本'])
    main.querySelectorAll('button').forEach(button => {
      if (!disabledLabels.has(normalizedText(button))) return
      button.disabled = true
      button.setAttribute('aria-disabled', 'true')
      button.title = '项目经营事实通过正式数据发布门禁后才可使用'
    })
  }

  function authToken() {
    return localStorage.getItem('cockpit_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || ''
  }

  function showNavigationMessage(message, tone = 'info') {
    let toast = document.querySelector('.aph-navigation-toast')
    if (!toast) {
      toast = document.createElement('div')
      toast.className = 'aph-navigation-toast'
      toast.setAttribute('role', 'status')
      toast.setAttribute('aria-live', 'polite')
      document.body.append(toast)
    }
    toast.dataset.tone = tone
    toast.textContent = message
    toast.hidden = false
    window.clearTimeout(Number(toast.dataset.timer || 0))
    toast.dataset.timer = String(window.setTimeout(() => { toast.hidden = true }, 5000))
  }

  async function openReviewSystem() {
    if (reviewOpening) return
    reviewOpening = true
    showNavigationMessage('正在连接研发审核系统…')
    try {
      const token = authToken()
      const response = await previousFetch('/api/integrations/review/sso', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.url) throw new Error(payload.error || `单点登录失败（${response.status}）`)
      window.location.assign(payload.url)
    } catch (error) {
      reviewOpening = false
      showNavigationMessage(error?.message || '研发审核系统暂时无法打开', 'danger')
    }
  }

  function navigateHost(href) {
    const target = new URL(href, window.location.origin)
    if (target.pathname === '/admin/') target.pathname = '/admin'
    if (target.pathname === '/system/' || target.pathname === '/system') target.pathname = '/admin'
    if (target.pathname === '/review' && !target.search) target.search = '?view=workbench'
    if (target.pathname === '/arrears') {
      window.location.assign(target.pathname)
      return
    }
    const next = `${target.pathname}${target.search}${target.hash}`
    window.history.pushState(window.history.state, '', next)
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  }

  function bindSpecialNavigation() {
    if (document.documentElement.dataset.aphRemediationNavigation === '1') return
    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target.closest('a[href]')
      if (!anchor) return
      const target = new URL(anchor.href, window.location.origin)
      if (target.origin !== window.location.origin) return
      if (target.pathname === '/admin/') {
        event.preventDefault()
        event.stopImmediatePropagation()
        navigateHost('/admin')
      } else if (target.pathname === '/review' && anchor.closest('.aph-exact-sidebar,.aph-mobile-primary-nav,.aph-mobile-more-drawer')) {
        event.preventDefault()
        event.stopImmediatePropagation()
        navigateHost('/review?view=workbench')
      }
    }, true)
    document.documentElement.dataset.aphRemediationNavigation = '1'
  }

  function enhanceMobilePrimaryNavigation() {
    if (!document.body || document.querySelector('.aph-mobile-primary-nav')) return
    const nav = document.createElement('nav')
    nav.className = 'aph-mobile-primary-nav'
    nav.setAttribute('aria-label', '移动端主导航')
    const primary = [
      { href: '/command', label: '工作台' },
      { href: '/', label: '驾驶舱' },
      { href: '/projects', label: '项目' },
    ]
    primary.forEach(item => {
      const link = document.createElement('a')
      link.href = item.href
      link.textContent = item.label
      link.dataset.aphMobileHref = item.href
      link.addEventListener('click', event => {
        event.preventDefault()
        navigateHost(item.href)
      })
      nav.append(link)
    })
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'aph-mobile-more-trigger'
    trigger.textContent = '更多'
    trigger.setAttribute('aria-expanded', 'false')
    trigger.setAttribute('aria-controls', 'aph-mobile-more-drawer')
    nav.append(trigger)

    const drawer = document.createElement('section')
    drawer.id = 'aph-mobile-more-drawer'
    drawer.className = 'aph-mobile-more-drawer'
    drawer.hidden = true
    drawer.setAttribute('role', 'dialog')
    drawer.setAttribute('aria-modal', 'true')
    drawer.setAttribute('aria-label', '更多功能')
    const items = [
      ['/payment', '回款额执行'], ['/daily', '每日回款'], ['/collection', '收缴率'],
      ['/arrears', '欠费分析'], ['/ai-alerts', 'AI预警'], ['/ai-report', 'AI月报'],
      ['/review?view=workbench', '研发审核'], ['/admin', '系统管理'],
    ]
    const heading = document.createElement('header')
    const title = document.createElement('strong')
    title.textContent = '更多功能'
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '关闭'
    close.setAttribute('aria-label', '关闭更多功能')
    heading.append(title, close)
    const grid = document.createElement('div')
    grid.className = 'aph-mobile-more-grid'
    items.forEach(([href, label]) => {
      const link = document.createElement('a')
      link.href = href
      link.textContent = label
      link.addEventListener('click', event => {
        event.preventDefault()
        closeDrawer()
        navigateHost(href)
      })
      grid.append(link)
    })
    drawer.append(heading, grid)
    document.body.append(nav, drawer)
    document.body.classList.add('aph-mobile-nav-ready')

    function openDrawer() {
      drawer.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      document.body.classList.add('aph-mobile-drawer-open')
      close.focus()
    }
    function closeDrawer() {
      drawer.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
      document.body.classList.remove('aph-mobile-drawer-open')
      trigger.focus({ preventScroll: true })
    }
    trigger.addEventListener('click', () => drawer.hidden ? openDrawer() : closeDrawer())
    close.addEventListener('click', closeDrawer)
    drawer.addEventListener('click', event => { if (event.target === drawer) closeDrawer() })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !drawer.hidden) closeDrawer()
    })
  }

  function replaceStateParam(key, value) {
    if (!stateKeys.includes(key)) return
    const params = new URLSearchParams(window.location.search)
    const normalized = String(value || '').trim()
    if (normalized) params.set(key, normalized)
    else params.delete(key)
    const search = params.toString()
    const next = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`
    window.history.replaceState(window.history.state, '', next)
  }

  function setNativeControlValue(control, value) {
    const prototype = control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(control, value)
    else control.value = value
  }

  function enhanceShareablePageState(main, pathname) {
    if (!main) return
    const params = new URLSearchParams(window.location.search)
    const bind = (control, key, eventName = 'change') => {
      if (!control || control.dataset.aphUrlStateBound === key) return
      const initial = params.get(key)
      if (initial && String(control.value) !== initial) {
        const optionExists = !(control instanceof HTMLSelectElement) || Array.from(control.options).some(option => option.value === initial)
        if (optionExists) {
          setNativeControlValue(control, initial)
          control.dispatchEvent(new Event(eventName, { bubbles: true }))
        }
      }
      control.addEventListener(eventName, () => replaceStateParam(key, control.value))
      control.dataset.aphUrlStateBound = key
    }

    const area = main.querySelector('[data-project-filter="area"], select[aria-label*="片区"], select[aria-label*="区域"]')
      || Array.from(main.querySelectorAll('select')).find(select => Array.from(select.options).some(option => /全部片区|全部区域|全部项目/.test(option.textContent || '')))
    bind(area, 'area')
    bind(main.querySelector('input[type="date"]'), 'date')
    const query = main.querySelector('[data-project-filter="q"], input[type="search"], input[placeholder*="搜索"]')
    bind(query, 'q', 'input')

    main.querySelectorAll('[data-collection-view]').forEach(button => {
      if (button.dataset.aphUrlTabBound === '1') return
      button.addEventListener('click', () => replaceStateParam('tab', button.dataset.collectionView || ''))
      button.dataset.aphUrlTabBound = '1'
    })
    const requestedTab = params.get('tab')
    if (pathname === '/collection' && requestedTab && ['overview', 'details'].includes(requestedTab)) {
      window.sessionStorage.setItem('aph-collection-view', requestedTab)
      const button = main.querySelector(`[data-collection-view="${requestedTab}"]`)
      if (button && button.getAttribute('aria-selected') !== 'true') button.click()
    }

    main.querySelectorAll('th button,[data-aph-sort-key]').forEach(button => {
      if (button.dataset.aphUrlSortBound === '1') return
      button.addEventListener('click', () => {
        const key = button.dataset.aphSortKey || normalizedText(button)
        const direction = button.closest('th')?.getAttribute('aria-sort') || ''
        replaceStateParam('sort', `${key}:${direction || 'next'}`)
      })
      button.dataset.aphUrlSortBound = '1'
    })
  }

  function enhanceCollectionDefault(main, pathname) {
    if (pathname !== '/collection' || !main) return
    const params = new URLSearchParams(window.location.search)
    const stored = window.sessionStorage.getItem('aph-collection-view')
    const detailsButton = main.querySelector('[data-collection-view="details"]')
    if (!params.has('tab') && !stored && detailsButton && detailsButton.dataset.aphDefaultApplied !== '1') {
      detailsButton.dataset.aphDefaultApplied = '1'
      window.sessionStorage.setItem('aph-collection-view', 'details')
      replaceStateParam('tab', 'details')
      detailsButton.click()
    }
  }

  function ensureBusinessHeading(main, pathname) {
    if (!main) return
    document.querySelectorAll('main:not(#main-content) h1[data-aph-business-heading="true"]').forEach(heading => heading.remove())

    const markOnly = target => {
      main.querySelectorAll('h1[data-aph-business-heading="true"]').forEach(heading => {
        if (heading === target) return
        if (heading.classList.contains('aph-visually-hidden')) heading.remove()
        else heading.removeAttribute('data-aph-business-heading')
      })
      target.dataset.aphBusinessHeading = 'true'
      main.removeAttribute('data-aph-business-heading-pending')
    }

    const nativeHeadings = [...main.querySelectorAll('h1:not([data-aph-business-heading="true"])')]
    const preferredNative = pathname === '/'
      ? main.querySelector('.aph-business-banner h1') || nativeHeadings[0]
      : nativeHeadings[0]
    if (preferredNative) {
      markOnly(preferredNative)
      return
    }

    const marked = [...main.querySelectorAll('h1[data-aph-business-heading="true"]')]
    if (marked.length) {
      markOnly(marked[0])
      return
    }
    if (main.dataset.aphBusinessHeadingPending === 'true') return
    main.dataset.aphBusinessHeadingPending = 'true'
    window.setTimeout(() => {
      if (!main.isConnected) return
      main.removeAttribute('data-aph-business-heading-pending')
      const lateNative = pathname === '/'
        ? main.querySelector('.aph-business-banner h1') || main.querySelector('h1:not([data-aph-business-heading="true"])')
        : main.querySelector('h1:not([data-aph-business-heading="true"])')
      if (lateNative) {
        markOnly(lateNative)
        return
      }
      const existing = main.querySelector('h1[data-aph-business-heading="true"]')
      if (existing) {
        markOnly(existing)
        return
      }
      const heading = document.createElement('h1')
      heading.className = 'aph-visually-hidden'
      heading.textContent = routeTitles[pathname] || document.title || '华北地区经营驾驶舱'
      main.prepend(heading)
      markOnly(heading)
    }, 350)
  }

  function loadSummary() {
    if (summaryPromise) return summaryPromise
    const token = authToken()
    summaryPromise = previousFetch('/api/summary', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`summary ${response.status}`)))
      .catch(() => null)
    return summaryPromise
  }

  function formatBusinessDate(value) {
    const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/)
    return match ? match[0] : '—'
  }

  function enhanceSourceFreshness(main, pathname) {
    const eligible = ['/', '/command', '/collection'].includes(pathname)
    const existing = document.querySelector('body > .aph-source-freshness')
    if (!main || !eligible) {
      existing?.remove()
      document.body?.classList.remove('aph-source-freshness-visible')
      return
    }
    const headerStatus = document.querySelector('.aph-header-status')
    if (headerStatus) headerStatus.classList.add('aph-source-scoped-status')
    document.body.classList.add('aph-source-freshness-visible')
    if (existing) return
    loadSummary().then(summary => {
      if (!summary || !main.isConnected || document.querySelector('body > .aph-source-freshness')) return
      if (!['/', '/command', '/collection'].includes(window.location.pathname)) return
      const panel = document.createElement('section')
      panel.className = 'aph-source-freshness'
      panel.setAttribute('aria-label', '数据源新鲜度')
      const rows = [
        {
          label: 'APH回款',
          date: summary.aphBusinessDate,
          status: summary.aphSourceStatus === 'available' ? '已验证' : '暂不可用',
          tone: summary.aphSourceStatus === 'available' ? 'available' : 'unavailable',
        },
        {
          label: '绿仔收缴',
          date: summary.collectionBusinessDate || summary.collectionExtractedAt,
          status: summary.collectionPublicationStatus === 'published' ? '已发布' : summary.collectionPublicationStatus === 'blocked' ? '未发布' : '暂不可用',
          tone: summary.collectionPublicationStatus === 'published' ? 'available' : 'unavailable',
        },
      ]
      rows.forEach(row => {
        const article = document.createElement('article')
        article.dataset.status = row.tone
        const label = document.createElement('strong')
        const date = document.createElement('time')
        const status = document.createElement('span')
        label.textContent = row.label
        date.textContent = formatBusinessDate(row.date)
        status.textContent = row.status
        article.append(label, date, status)
        panel.append(article)
      })
      document.body.append(panel)
    })
  }

  function applyRemediation() {
    if (!document.body) return
    const pathname = window.location.pathname
    const main = document.getElementById('main-content')
    document.body.dataset.aphRemediationRelease = RELEASE
    bindSpecialNavigation()
    enhanceMobilePrimaryNavigation()
    ensureBusinessHeading(main, pathname)
    enhanceShareablePageState(main, pathname)
    enhanceCollectionDefault(main, pathname)
    enhanceAiAlertsGateState(main, pathname)
    enhanceAiReportGateState(main, pathname)
    enhanceSourceFreshness(main, pathname)
  }

  if (document.body) applyRemediation()
  else document.addEventListener('DOMContentLoaded', applyRemediation, { once: true })

  const start = () => {
    const root = document.getElementById('root') || document.documentElement
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true })
  }
  if (document.documentElement) start()
  else document.addEventListener('readystatechange', start, { once: true })
})()
