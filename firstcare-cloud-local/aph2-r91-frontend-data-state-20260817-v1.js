/* R91：经营数据依据的加载、权限、时效与发布状态；只读且不计算业务指标。 */
(function () {
  'use strict'

  const PANEL_ID = 'aph-r91-frontend-data-state'
  const HOST_ID = 'aph-r91-frontend-data-state-host'
  const TOKEN_KEYS = ['cockpit_token', 'authToken', 'token']
  const ACTIVE_ROUTES = new Set(['/', '/command', '/projects', '/ai-report', '/ai-alerts'])
  const READY_STATUSES = new Set(['ready', 'available', 'published'])
  const UNPUBLISHED_STATUSES = new Set(['staged', 'previewed', 'unpublished', 'blocked'])
  const STALE_STATUSES = new Set(['stale', 'expired'])
  let requestId = 0

  function route() {
    if (typeof window.location === 'undefined') return '/'
    return window.location.pathname.replace(/\/$/, '') || '/'
  }

  function isActiveRoute(pathname) {
    const normalized = String(pathname || '/').replace(/\/$/, '') || '/'
    return ACTIVE_ROUTES.has(normalized)
  }

  function token() {
    return TOKEN_KEYS.map(key => window.localStorage?.getItem(key)).find(Boolean) || ''
  }

  function formatCount(value) {
    if (value === null || value === undefined || value === '') return '—'
    const number = Number(value)
    return Number.isSafeInteger(number) && number >= 0 ? String(number) : '—'
  }

  function formatBusinessDate(value) {
    return value ? `业务日期 ${String(value)}` : '业务日期 —'
  }

  function classifySource(name, source) {
    const status = String(source?.status || '').toLowerCase()
    const publicationStatus = String(source?.publicationStatus || '').toLowerCase()
    if (name === 'lvzai' && publicationStatus !== 'published') {
      if (UNPUBLISHED_STATUSES.has(publicationStatus) || READY_STATUSES.has(status)) {
        return { state: 'unpublished', label: '尚未正式发布', tone: 'warning' }
      }
    }
    if (STALE_STATUSES.has(status)) return { state: 'stale', label: '数据已过期', tone: 'warning' }
    if (UNPUBLISHED_STATUSES.has(status)) return { state: 'unpublished', label: '尚未正式发布', tone: 'warning' }
    if (status === 'partial') return { state: 'partial', label: '部分可用', tone: 'warning' }
    if (READY_STATUSES.has(status)) return { state: 'ready', label: '正式来源可用', tone: 'success' }
    return { state: 'unavailable', label: '暂无权威来源', tone: 'neutral' }
  }

  function publicationLabel(value) {
    const status = String(value || '').toLowerCase()
    if (status === 'published') return '已发布'
    if (UNPUBLISHED_STATUSES.has(status)) return '待发布'
    return '—'
  }

  function sourceView(name, label, source) {
    const status = classifySource(name, source)
    const detail = name === 'aph'
      ? `回款中心 ${formatCount(source?.paymentCenterCount)} 个；每日数据已验证 ${formatCount(source?.verifiedDailyCenterCount)} 个中心`
      : `当前权限范围 ${formatCount(source?.centerCount)} 个服务中心；发布状态 ${publicationLabel(source?.publicationStatus)}`
    return {
      name: label,
      date: formatBusinessDate(source?.businessDate),
      detail,
      status,
    }
  }

  function createViewModel(input) {
    if (input.kind === 'loading') {
      return {
        kind: 'loading',
        title: '正在核验数据依据',
        summary: '正在读取正式来源与发布状态',
        live: '经营数据依据正在加载',
        retryable: false,
        busy: true,
        sources: [],
        policy: '',
      }
    }
    if (input.kind === 'unauthorized') {
      return { kind: 'unauthorized', title: '登录状态已失效', summary: '请重新登录后查看经营数据依据', live: '登录状态已失效', retryable: false, busy: false, sources: [], policy: '' }
    }
    if (input.kind === 'forbidden') {
      return { kind: 'forbidden', title: '无权查看数据依据', summary: '当前账号没有该数据范围的查看权限', live: '无权查看经营数据依据', retryable: false, busy: false, sources: [], policy: '' }
    }
    if (input.kind === 'error') {
      return { kind: 'error', title: '数据依据加载失败', summary: '未使用旧缓存或其他来源替代，请稍后重试', live: '经营数据依据加载失败', retryable: true, busy: false, sources: [], policy: '' }
    }

    const payload = input.payload && typeof input.payload === 'object' ? input.payload : {}
    const sources = []
    if (payload.sources?.aph) sources.push(sourceView('aph', 'APH', payload.sources.aph))
    if (payload.sources?.lvzai) sources.push(sourceView('lvzai', '绿仔', payload.sources.lvzai))
    const projectPolicy = payload.presentationPolicy?.showProjectOperatingMetrics
      ? '项目经营指标已具备可验证直接来源。'
      : `项目目录只用于名称与归属；成本、利润率、品质、安全、满意度等项目经营指标${payload.presentationPolicy?.excludedValueLabel || '当前系统不接入'}。`
    if (!sources.length) {
      return {
        kind: 'empty',
        title: '暂无正式数据依据',
        summary: '当前权限范围暂无已验证的正式来源',
        live: '暂无已验证的正式来源',
        retryable: true,
        busy: false,
        sources,
        policy: projectPolicy,
      }
    }
    const allReady = payload.status === 'ready' && sources.every(source => source.status.state === 'ready')
    if (allReady) {
      return {
        kind: 'ready',
        title: '数据依据',
        summary: 'APH、绿仔正式来源可用',
        live: '经营数据依据核验完成',
        retryable: false,
        busy: false,
        sources,
        policy: projectPolicy,
      }
    }
    return {
      kind: 'warning',
      title: '数据依据待核验',
      summary: '未发布、过期或不完整来源不可作为当前正式经营事实',
      live: '经营数据依据存在未发布、过期或不完整来源',
      retryable: true,
      busy: false,
      sources,
      policy: projectPolicy,
    }
  }

  const contract = Object.freeze({
    classifySource,
    createViewModel,
    formatBusinessDate,
    formatCount,
    isActiveRoute,
  })
  window.__cockpitFrontendDataState = contract

  if (typeof document === 'undefined' || !document.documentElement) return

  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function fallbackHost() {
    const existing = document.getElementById(HOST_ID)
    if (existing) return existing
    const root = document.getElementById('root')
    if (!root) return null
    const host = element('section', 'aph-r91-fallback-host')
    host.id = HOST_ID
    host.setAttribute('aria-label', '经营数据依据')
    root.insertAdjacentElement('afterend', host)
    return host
  }

  function render(model) {
    if (!isActiveRoute(route())) return false
    const host = fallbackHost()
    if (!host) return false
    document.getElementById(PANEL_ID)?.remove()

    const panel = element('details', `aph-r91-data-state is-${model.kind}`)
    panel.id = PANEL_ID
    panel.dataset.state = model.kind
    panel.setAttribute('aria-busy', model.busy ? 'true' : 'false')

    const summary = element('summary', '')
    const heading = element('span', 'aph-r91-title', model.title)
    heading.id = `${PANEL_ID}-title`
    summary.append(heading, element('span', 'aph-r91-summary', model.summary))
    panel.setAttribute('aria-labelledby', heading.id)

    const live = element('p', 'aph-r91-live', model.live)
    live.setAttribute('aria-live', model.kind === 'error' ? 'assertive' : 'polite')
    live.setAttribute('aria-atomic', 'true')

    const content = element('div', 'aph-r91-content')
    model.sources.forEach(source => {
      const row = element('article', `aph-r91-source-row is-${source.status.tone}`)
      const rowHeading = element('div', 'aph-r91-source-heading')
      rowHeading.append(element('strong', '', source.name), element('span', '', source.status.label))
      row.append(rowHeading, element('p', 'aph-r91-source-date', source.date), element('p', '', source.detail))
      content.append(row)
    })
    if (model.policy) content.append(element('p', 'aph-r91-policy', model.policy))
    if (model.retryable) {
      const actions = element('div', 'aph-r91-actions')
      const retry = element('button', 'aph-r91-retry', '重新核验')
      retry.type = 'button'
      retry.addEventListener('click', refresh)
      actions.append(retry)
      content.append(actions)
    }
    panel.append(summary, live, content)
    host.append(panel)
    document.documentElement.dataset.r91FrontendDataState = model.kind
    return true
  }

  function renderWhenReady(model, attempts, expectedRequest, expectedRoute) {
    if (expectedRequest !== requestId || expectedRoute !== route()) return
    if (render(model) || attempts >= 20) return
    window.setTimeout(() => renderWhenReady(model, attempts + 1, expectedRequest, expectedRoute), 100)
  }

  function clear() {
    document.getElementById(PANEL_ID)?.remove()
    document.getElementById(HOST_ID)?.remove()
    delete document.documentElement.dataset.r91FrontendDataState
    delete window.__cockpitOperatingCapabilities
  }

  async function refresh() {
    const currentRequest = ++requestId
    const currentRoute = route()
    clear()
    if (!isActiveRoute(currentRoute)) return
    renderWhenReady(createViewModel({ kind: 'loading' }), 0, currentRequest, currentRoute)

    const bearer = token()
    if (!bearer) {
      renderWhenReady(createViewModel({ kind: 'unauthorized', status: 401 }), 0, currentRequest, currentRoute)
      return
    }

    try {
      const response = await window.fetch('/api/operating-capabilities', {
        headers: { Authorization: `Bearer ${bearer}` },
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (currentRequest !== requestId || currentRoute !== route()) return
      if (response.status === 401) {
        renderWhenReady(createViewModel({ kind: 'unauthorized', status: 401 }), 0, currentRequest, currentRoute)
        return
      }
      if (response.status === 403) {
        renderWhenReady(createViewModel({ kind: 'forbidden', status: 403 }), 0, currentRequest, currentRoute)
        return
      }
      if (!response.ok) throw new Error(`能力清单请求失败：${response.status}`)
      const payload = await response.json()
      if (currentRequest !== requestId || currentRoute !== route()) return
      window.__cockpitOperatingCapabilities = payload
      window.dispatchEvent(new CustomEvent('cockpit:operating-capabilities', { detail: payload }))
      renderWhenReady(createViewModel({ kind: 'data', payload }), 0, currentRequest, currentRoute)
    } catch (error) {
      if (currentRequest !== requestId || currentRoute !== route()) return
      renderWhenReady(createViewModel({ kind: 'error' }), 0, currentRequest, currentRoute)
      window.dispatchEvent(new CustomEvent('cockpit:operating-capabilities-error', { detail: { message: error instanceof Error ? error.message : String(error) } }))
    }
  }

  refresh()
  window.addEventListener('cockpit:navigation', refresh)
  window.addEventListener('aph:r45-integrated-mounted', refresh)
  window.addEventListener('popstate', refresh)
  window.addEventListener('storage', event => {
    if (TOKEN_KEYS.includes(event.key)) refresh()
  })
})()
