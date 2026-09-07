/* R65：沟通文件选填，并仅展示服务端整批 AI 分析结论。 */
(() => {
  'use strict'

  const originalFetch = window.fetch.bind(window)
  const incompleteStatuses = new Set([
    'parsed', 'queued', 'pending', 'running', 'analyzing', 'rule_only',
    'partial', 'failed', 'discarded', 'revoked', 'blocked',
  ])
  const completeStatuses = new Set(['analyzed', 'completed', 'complete', 'ready'])
  let latestResultsRequest = 0

  const byId = (id) => document.getElementById(id)

  function text(value, limit = 600) {
    if (value === undefined || value === null) return ''
    const normalized = String(value).replace(/\s+/g, ' ').trim()
    if (!normalized) return ''
    return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
  }

  function firstText(values, limit) {
    for (const value of values) {
      const normalized = text(value, limit)
      if (normalized) return normalized
    }
    return ''
  }

  function parsePossibleJson(value) {
    if (typeof value !== 'string') return value
    const normalized = value.trim()
    if (!normalized.startsWith('{') && !normalized.startsWith('[')) return value
    try { return JSON.parse(normalized) } catch { return value }
  }

  function formatInteger(value) {
    const number = Number(value)
    return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(number) : ''
  }

  function formatMoney(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return ''
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(number)
  }

  function formatPercent(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return ''
    const percentage = Math.abs(number) <= 1 ? number * 100 : number
    return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(percentage)}%`
  }

  function normalizeFact(item) {
    if (typeof item === 'string' || typeof item === 'number') return text(item, 240)
    if (!item || typeof item !== 'object') return ''
    const direct = firstText([item.text, item.fact, item.summary, item.description], 240)
    if (direct) return direct
    const label = firstText([item.label, item.name, item.title], 80)
    const value = firstText([item.value, item.content, item.detail], 160)
    return label && value ? `${label}：${value}` : (label || value)
  }

  function explicitFacts(source) {
    const candidates = [source?.keyFacts, source?.key_facts, source?.facts, source?.highlights]
    const collection = candidates.find(Array.isArray) || []
    return collection.map(normalizeFact).filter(Boolean)
  }

  function richFacts(source) {
    const scope = source?.scope || {}
    const review = source?.review || {}
    const aiSignals = source?.aiSignals || source?.ai_signals || {}
    const batch = source?.batch || {}
    const facts = []

    const resources = formatInteger(scope.analysisResources ?? scope.analysis_resources)
    if (resources) facts.push(`整批分析资源 ${resources} 项`)

    const arrearsTotal = formatMoney(scope.arrearsTotal ?? scope.arrears_total)
    if (arrearsTotal) facts.push(`整批欠费金额 ${arrearsTotal}`)

    const communicationPresent = batch.communicationFilePresent ?? batch.communication_file_present
    const coverage = formatPercent(scope.communicationCoverageRate ?? scope.communication_coverage_rate)
    if (communicationPresent === false) facts.push('未提供沟通文件，本轮仅按欠费台账事实分析')
    else if (coverage) facts.push(`沟通信号覆盖率 ${coverage}`)

    const confidence = formatPercent(aiSignals.averageConfidence ?? aiSignals.average_confidence)
    if (confidence) facts.push(`AI平均置信度 ${confidence}`)

    const pending = formatInteger(review.pending)
    const confirmed = formatInteger(review.confirmed)
    if (pending || confirmed) facts.push(`待复核 ${pending || '0'} 项 · 已确认 ${confirmed || '0'} 项`)
    return facts
  }

  function richMain(source) {
    const aiSignals = source?.aiSignals || source?.ai_signals || {}
    const topCauses = aiSignals.topCauses || aiSignals.top_causes
    const top = Array.isArray(topCauses) ? topCauses[0] : null
    if (top) {
      const label = firstText([top.label, top.category], 80) || '待人工核验'
      const count = formatInteger(top.resourceCount ?? top.resource_count)
      const share = formatPercent(top.share)
      const suffix = [count ? `${count} 项` : '', share].filter(Boolean).join('，')
      return `整批AI分析中，${label}是当前首要归因线索${suffix ? `（${suffix}）` : ''}。`
    }
    if (aiSignals.available === true) return '整批AI分析已完成，当前归因线索需结合欠费事实逐项复核。'
    if (aiSignals.available === false) return '整批分析已完成，当前未形成可用的AI归因线索。'
    return ''
  }

  function normalizeConclusion(value) {
    const source = parsePossibleJson(value)
    if (typeof source === 'string' || typeof source === 'number') {
      return { main: text(source), facts: [] }
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null

    const nested = source.conclusion && source.conclusion !== source ? parsePossibleJson(source.conclusion) : null
    const nestedMain = typeof nested === 'string' ? nested : firstText([
      nested?.mainConclusion, nested?.main_conclusion, nested?.main, nested?.summary, nested?.text,
    ], 600)
    const confirmed = source.confirmedConclusion || source.confirmed_conclusion || {}
    const headline = text(source.headline, 280)
    const summary = text(source.summary, 600)
    const headlineSummary = headline && summary && headline !== summary
      ? `${headline.replace(/[。！？.!?]+$/, '')}。${summary}`
      : (headline || summary)
    const main = firstText([
      source.mainConclusion,
      source.main_conclusion,
      source.main,
      headlineSummary,
      source.text,
      source.aiSignals?.summary,
      source.ai_signals?.summary,
      nestedMain,
      richMain(source),
      confirmed.summary,
    ], 600) || '整批AI分析已完成，尚未形成可直接使用的整批归因结论。'

    const facts = [...explicitFacts(source)]
    if (nested && typeof nested === 'object') facts.push(...explicitFacts(nested))
    if (!facts.length) facts.push(...richFacts(source))
    return { main, facts: [...new Set(facts)].slice(0, 4) }
  }

  function statusValues(context, conclusion) {
    const values = [
      context?.status,
      context?.aiStatus,
      context?.ai_status,
      context?.latestRun?.status,
      context?.latest_run?.status,
      conclusion?.status,
      conclusion?.analysisStatus,
      conclusion?.analysis_status,
      conclusion?.batch?.status,
      conclusion?.batch?.aiStatus,
      conclusion?.batch?.ai_status,
    ]
    return values.map((value) => text(value, 40).toLowerCase()).filter(Boolean)
  }

  function analysisComplete(context, conclusion) {
    if (context?.active_run_id || context?.activeRunId) return false
    const analysisStatus = conclusion?.analysisStatus ?? conclusion?.analysis_status
    if (analysisStatus && typeof analysisStatus === 'object' && analysisStatus.complete === false) return false
    const aiSignals = conclusion?.aiSignals ?? conclusion?.ai_signals
    if (aiSignals && typeof aiSignals === 'object' && aiSignals.available === false) return false
    const statuses = statusValues(context, conclusion)
    if (statuses.some((status) => incompleteStatuses.has(status))) return false
    return statuses.some((status) => completeStatuses.has(status))
  }

  function createElement(tag, className, content) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (content) element.textContent = content
    return element
  }

  function ensureConclusionPanel() {
    const existing = byId('r65AiConclusion')
    if (existing) return existing
    const header = document.querySelector('#r55ReviewWorkspace > .r55-review-header')
    if (!header) return null

    const section = createElement('section', 'r65-ai-conclusion')
    section.id = 'r65AiConclusion'
    section.hidden = true
    section.setAttribute('aria-labelledby', 'r65ConclusionTitle')
    section.setAttribute('aria-live', 'polite')
    section.dataset.source = 'whole-batch'

    const heading = createElement('div', 'r65-conclusion-heading')
    heading.append(
      createElement('span', 'r65-conclusion-mark', 'AI'),
      createElement('h4', '', 'AI分析结论'),
    )
    heading.lastElementChild.id = 'r65ConclusionTitle'

    const main = createElement('p', 'r65-conclusion-main')
    main.id = 'r65ConclusionMain'
    const facts = createElement('ul', 'r65-conclusion-facts')
    facts.id = 'r65ConclusionFacts'
    const boundary = createElement('p', 'r65-conclusion-boundary', '待人工复核 · AI分析仅提供经营线索，人工确认后方可作为正式结论或导出依据。')
    section.append(heading, main, facts, boundary)
    header.after(section)
    return section
  }

  function hideConclusion() {
    const panel = ensureConclusionPanel()
    if (!panel) return
    panel.hidden = true
    panel.removeAttribute('data-batch-id')
    byId('r65ConclusionMain')?.replaceChildren()
    byId('r65ConclusionFacts')?.replaceChildren()
  }

  function activeReviewMatches(batchId) {
    const workspace = byId('r55ReviewWorkspace')
    const title = byId('r55ReviewTitle')?.textContent || ''
    return Boolean(workspace && !workspace.hidden && title.includes(`批次 #${batchId}`))
  }

  function renderConclusion(batchId, value, context) {
    if (value?.available === false || !activeReviewMatches(batchId) || !analysisComplete(context, value)) {
      hideConclusion()
      return
    }
    const conclusion = normalizeConclusion(value)
    if (!conclusion?.main) {
      hideConclusion()
      return
    }
    const panel = ensureConclusionPanel()
    if (!panel) return
    byId('r65ConclusionMain').textContent = conclusion.main
    const facts = byId('r65ConclusionFacts')
    facts.replaceChildren(...conclusion.facts.map((fact) => createElement('li', '', fact)))
    facts.hidden = conclusion.facts.length === 0
    panel.dataset.batchId = String(batchId)
    panel.hidden = false
  }

  function requestHeaders(input, init) {
    if (init?.headers) return new Headers(init.headers)
    if (typeof Request !== 'undefined' && input instanceof Request) return new Headers(input.headers)
    return new Headers()
  }

  async function loadWholeBatchConclusion(batchId, context, headers, requestNumber) {
    try {
      const response = await originalFetch(`/api/arrears/batches/${batchId}/conclusion`, {
        method: 'GET', headers, credentials: 'same-origin',
      })
      if (!response.ok || requestNumber !== latestResultsRequest) return
      const body = await response.json()
      if (requestNumber !== latestResultsRequest) return
      renderConclusion(batchId, body?.conclusion ?? body, body?.batch ?? context)
    } catch {
      // 兼容后端合同尚未发布的窗口；无整批结论时保持隐藏，不回退到分页结果拼接。
    }
  }

  async function inspectResultsResponse(batchId, response, headers, requestNumber) {
    try {
      const body = await response.clone().json()
      if (requestNumber !== latestResultsRequest || !activeReviewMatches(batchId)) return
      const context = body?.batch || {}
      const embedded = body?.conclusion ?? body?.batch?.conclusion
      if (!analysisComplete(context, embedded)) {
        hideConclusion()
        return
      }
      if (embedded !== undefined && embedded !== null) {
        renderConclusion(batchId, embedded, context)
        return
      }
      hideConclusion()
      await loadWholeBatchConclusion(batchId, context, headers, requestNumber)
    } catch {
      hideConclusion()
    }
  }

  function sanitizeOptionalCommunication(url, method, body) {
    if (method !== 'POST' || url.pathname !== '/api/arrears/batches' || !(body instanceof FormData)) return
    const communication = body.get('communications')
    const isRealFile = typeof File !== 'undefined' && communication instanceof File
    if (!isRealFile) body.delete('communications')
  }

  window.fetch = async function r65Fetch(input, init = {}) {
    let url
    try {
      const target = typeof Request !== 'undefined' && input instanceof Request ? input.url : input
      url = new URL(String(target), window.location.href)
    } catch {
      return originalFetch(input, init)
    }
    const method = String(init.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase()
    sanitizeOptionalCommunication(url, method, init.body)

    const analyzeMatch = url.pathname.match(/^\/api\/arrears\/batches\/(\d+)\/analyze$/)
    if (method === 'POST' && analyzeMatch) hideConclusion()

    const resultsMatch = url.pathname.match(/^\/api\/arrears\/batches\/(\d+)\/results$/)
    const requestNumber = resultsMatch && method === 'GET' ? ++latestResultsRequest : 0
    if (requestNumber) {
      const panelBatch = byId('r65AiConclusion')?.dataset.batchId
      if (panelBatch && panelBatch !== resultsMatch[1]) hideConclusion()
    }

    const response = await originalFetch(input, init)
    if (requestNumber) {
      inspectResultsResponse(Number(resultsMatch[1]), response, requestHeaders(input, init), requestNumber)
    }
    return response
  }

  function optionalizeCommunication() {
    for (const id of ['r55CommunicationFile', 'communicationFile']) {
      const input = byId(id)
      if (!input) continue
      input.required = false
      input.removeAttribute('required')
      const label = input.closest('label')
      if (!label || label.textContent.includes('选填')) continue
      const firstTextNode = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)
      if (firstTextNode) firstTextNode.textContent = `${firstTextNode.textContent.trim()}（选填）`
    }
  }

  function start() {
    document.documentElement.dataset.r65ArrearsConclusion = 'true'
    optionalizeCommunication()
    ensureConclusionPanel()
    byId('r55AnalyzeSelected')?.addEventListener('click', hideConclusion, true)
    const workspace = byId('r55ReviewWorkspace')
    if (workspace) {
      new MutationObserver(() => { if (workspace.hidden) hideConclusion() }).observe(workspace, {
        attributes: true, attributeFilter: ['hidden'],
      })
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
