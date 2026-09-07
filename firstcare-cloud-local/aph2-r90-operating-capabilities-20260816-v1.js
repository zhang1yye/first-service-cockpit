/* R90：将APH、绿仔运行时能力清单展示为可展开的数据依据。 */
(function () {
  'use strict'

  const PANEL_ID = 'aph-r90-operating-capabilities'
  const FALLBACK_HOST_ID = 'aph-r90-operating-capabilities-host'
  const TOKEN_KEYS = ['cockpit_token', 'authToken', 'token']
  const ACTIVE_ROUTES = new Set(['/', '/command', '/projects', '/ai-report', '/ai-alerts'])
  const PROTECTED_ROUTES = new Set(['/daily', '/payment', '/collection'])
  let requestId = 0

  function route() {
    return window.location.pathname.replace(/\/$/, '') || '/'
  }

  function token() {
    return TOKEN_KEYS.map(key => window.localStorage.getItem(key)).find(Boolean) || ''
  }

  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function sourceStatus(source) {
    if (!source || source.status === 'unavailable') return '暂无权威来源'
    if (source.status === 'partial') return '部分可用'
    return '正式来源可用'
  }

  function sourceDate(source) {
    return source?.businessDate ? `业务日期 ${source.businessDate}` : '业务日期未发布'
  }

  function buildSourceRow(name, source, detail) {
    const row = element('div', 'aph-r90-source-row')
    const heading = element('div', 'aph-r90-source-heading')
    heading.append(element('strong', '', name), element('span', `is-${source?.status || 'unavailable'}`, sourceStatus(source)))
    row.append(heading, element('p', '', `${sourceDate(source)} · ${detail}`))
    return row
  }

  function buildPanel(payload) {
    const panel = element('details', 'aph-r90-data-basis')
    panel.id = PANEL_ID
    panel.dataset.status = payload.status || 'unavailable'

    const summary = element('summary', '')
    summary.append(
      element('span', 'aph-r90-title', '数据依据'),
      element('span', 'aph-r90-summary', payload.status === 'ready' ? 'APH、绿仔正式来源可用' : '仅展示当前可验证来源')
    )

    const content = element('div', 'aph-r90-content')
    const aph = payload.sources?.aph
    const lvzai = payload.sources?.lvzai
    const aphDetail = aph?.status === 'unavailable'
      ? '当前权限范围暂无已验证记录'
      : `回款中心 ${aph?.paymentCenterCount} 个；每日数据已验证 ${aph?.verifiedDailyCenterCount} 个中心`
    const lvzaiDetail = lvzai?.status === 'unavailable'
      ? '当前权限范围暂无已发布正式批次'
      : `当前权限范围 ${lvzai?.centerCount} 个服务中心；发布状态 ${lvzai?.publicationStatus || '未发布'}`
    content.append(
      buildSourceRow('APH', aph, aphDetail),
      buildSourceRow('绿仔', lvzai, lvzaiDetail)
    )

    const policy = element('p', 'aph-r90-policy')
    policy.textContent = payload.presentationPolicy?.showProjectOperatingMetrics
      ? '项目经营指标已具备可验证直接来源。'
      : `项目目录只用于名称与归属；成本、利润率、品质、安全、满意度等项目经营指标${payload.presentationPolicy?.excludedValueLabel || '当前系统不接入'}。`
    content.append(policy)
    panel.append(summary, content)
    return panel
  }

  function fallbackHost() {
    const existing = document.getElementById(FALLBACK_HOST_ID)
    if (existing) return existing
    const root = document.getElementById('root')
    if (!root) return null
    const host = element('section', 'aph-r90-fallback-host')
    host.id = FALLBACK_HOST_ID
    host.setAttribute('aria-label', '经营数据依据')
    root.insertAdjacentElement('afterend', host)
    return host
  }

  function mount(payload) {
    if (!ACTIVE_ROUTES.has(route()) || PROTECTED_ROUTES.has(route())) return false
    const host = fallbackHost()
    if (!host) return false
    document.getElementById(PANEL_ID)?.remove()
    host.append(buildPanel(payload))
    document.documentElement.dataset.r90OperatingStatus = payload.status || 'unavailable'
    return true
  }

  function mountWhenReady(payload, attempts) {
    const mounted = mount(payload)
    if (mounted || attempts >= 20) return
    window.setTimeout(() => mountWhenReady(payload, attempts + 1), 100)
  }

  async function refresh() {
    const currentRoute = route()
    document.getElementById(PANEL_ID)?.remove()
    document.getElementById(FALLBACK_HOST_ID)?.remove()
    delete document.documentElement.dataset.r90OperatingStatus
    if (!ACTIVE_ROUTES.has(currentRoute) || PROTECTED_ROUTES.has(currentRoute)) return

    const bearer = token()
    if (!bearer) return
    const currentRequest = ++requestId
    try {
      const response = await window.fetch('/api/operating-capabilities', {
        headers: { Authorization: `Bearer ${bearer}` },
        credentials: 'same-origin',
        cache: 'no-store'
      })
      if (!response.ok) throw new Error(`能力清单请求失败：${response.status}`)
      const payload = await response.json()
      if (currentRequest !== requestId || currentRoute !== route()) return
      window.__cockpitOperatingCapabilities = payload
      window.dispatchEvent(new CustomEvent('cockpit:operating-capabilities', { detail: payload }))
      mountWhenReady(payload, 0)
    } catch (error) {
      if (currentRequest !== requestId) return
      document.documentElement.dataset.r90OperatingStatus = 'unavailable'
      mountWhenReady({
        status: 'unavailable',
        sources: {},
        presentationPolicy: {
          showProjectOperatingMetrics: false,
          projectOperatingMetricsPolicy: 'not-connected',
          excludedValueLabel: '当前系统不接入'
        }
      }, 0)
      window.dispatchEvent(new CustomEvent('cockpit:operating-capabilities-error', { detail: { message: error.message } }))
    }
  }

  refresh()
  window.addEventListener('cockpit:navigation', refresh)
  window.addEventListener('popstate', refresh)
  window.addEventListener('storage', event => {
    if (TOKEN_KEYS.includes(event.key)) refresh()
  })
})()
