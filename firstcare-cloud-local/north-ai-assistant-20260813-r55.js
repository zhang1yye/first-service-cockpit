(() => {
  'use strict'
  const ID = 'north-ai-assistant'
  const APP_ROUTES = new Set([
    '/', '/command', '/projects', '/payment', '/daily', '/collection', '/arrears',
    '/ai-alerts', '/ai-report', '/import', '/review', '/system', '/admin', '/tasks',
  ])
  const authenticated = Boolean(localStorage.getItem('cockpit_token') || localStorage.getItem('token'))
  if (window.location.pathname === '/login' || !authenticated) return
  if (document.getElementById(ID)) return

  const state = { open: false, busy: false, context: null, messages: [], lastTopic: '' }
  const root = document.createElement('div')
  root.id = ID
  root.innerHTML = `
    <button class="north-ai-launcher" type="button" aria-label="打开华北经营助手" aria-haspopup="dialog">
      <span class="north-ai-launcher-mark" aria-hidden="true"></span>
      <span class="north-ai-launcher-copy"><strong>华北经营助手</strong><span>查中心 · 看异常 · 要建议</span></span>
      <span class="north-ai-launcher-dot" aria-hidden="true"></span>
    </button>
    <div class="north-ai-overlay" aria-hidden="true">
      <section class="north-ai-panel" role="dialog" aria-modal="true" aria-labelledby="north-ai-title">
        <header class="north-ai-header">
          <h2 id="north-ai-title" class="north-ai-sr-only">华北经营助手</h2>
          <button class="north-ai-close" type="button" aria-label="关闭华北经营助手">×</button>
        </header>
        <div class="north-ai-conversation" role="log" aria-live="polite">
          <section class="north-ai-welcome">
            <div class="north-ai-aph-mark" aria-hidden="true"><span>A</span></div>
            <h3>华北经营助手</h3>
            <p>问我任一服务中心，我会直接给出真实数据、未达标指标、AI判断和下一步建议。</p>
            <div class="north-ai-context-status"><span class="north-ai-status">正在核验数据状态…</span></div>
          </section>
          <div class="north-ai-suggestions"></div>
          <div class="north-ai-messages"></div>
        </div>
        <footer class="north-ai-composer-wrap">
          <form class="north-ai-composer">
            <textarea class="north-ai-input" rows="1" maxlength="500" placeholder="请输入你的问题" aria-label="输入经营问题"></textarea>
            <button class="north-ai-send" type="submit" aria-label="发送问题">➜</button>
          </form>
          <p class="north-ai-disclaimer">只展示经营结论与建议；详细依据保留在审计记录中。AI仅做只读分析。</p>
        </footer>
      </section>
    </div>`
  document.body.appendChild(root)

  const launcher = root.querySelector('.north-ai-launcher')
  const overlay = root.querySelector('.north-ai-overlay')
  const panel = root.querySelector('.north-ai-panel')
  const closeButton = root.querySelector('.north-ai-close')
  const conversation = root.querySelector('.north-ai-conversation')
  const statusBox = root.querySelector('.north-ai-context-status')
  const suggestionsBox = root.querySelector('.north-ai-suggestions')
  const messagesBox = root.querySelector('.north-ai-messages')
  const form = root.querySelector('.north-ai-composer')
  const input = root.querySelector('.north-ai-input')
  const sendButton = root.querySelector('.north-ai-send')

  const token = () => localStorage.getItem('cockpit_token') || localStorage.getItem('token') || ''
  const isAssistantRoute = () => {
    const current = window.location.pathname.replace(/\/+$/, '') || '/'
    return APP_ROUTES.has(current) || current.startsWith('/projects/')
  }
  const authHeaders = () => ({ 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) })
  const statusLabel = status => status === 'verified' ? '数据已验证' : status === 'warning' ? '存在待复核差异' : '部分数据不可用'

  // 保留后端门禁元数据，让用户能区分“名称待确认”、“数据不可用”和“AI服务不可用”。
  function responseErrorMeta(data, status) {
    const code = String(data?.code || '')
    const labels = {
      CENTER_PAYMENT_NOT_RESOLVED: '服务中心名称待确认',
      CENTER_PAYMENT_DATA_UNAVAILABLE: '服务中心数据暂不可用',
      SERVICE_CENTER_OUT_OF_SCOPE: '该服务中心不在当前账号范围内',
      ASSISTANT_DATA_UNAVAILABLE: '经营数据暂不可用',
      PROJECT_DATA_QUALITY_BLOCKED: '项目真实性门禁阻断',
      APPROVED_KNOWLEDGE_UNAVAILABLE: '已批准知识不足',
      KNOWLEDGE_SELECTION_REQUIRED: '请选择标准',
      AI_GENERATION_UNAVAILABLE: 'AI生成服务暂不可用',
    }
    return {
      ...(data && typeof data === 'object' ? data : {}),
      qualityStatus: data?.qualityStatus || 'unavailable',
      errorCode: code,
      errorLabel: labels[code] || (status === 429 ? '请求过于频繁' : '请求未完成'),
      statusCode: status,
    }
  }

  function syncRoute() {
    const visible = isAssistantRoute()
    launcher.hidden = !visible
    launcher.toggleAttribute('hidden', !visible)
    if (!visible && state.open) close()
  }

  function open() {
    state.open = true
    overlay.classList.add('is-open')
    overlay.setAttribute('aria-hidden', 'false')
    document.documentElement.style.overflow = 'hidden'
    window.setTimeout(() => input.focus(), 240)
    if (!state.context) loadContext()
  }

  function close() {
    state.open = false
    overlay.classList.remove('is-open')
    overlay.setAttribute('aria-hidden', 'true')
    document.documentElement.style.overflow = ''
    launcher.focus()
  }

  function scrollToBottom() {
    window.requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight })
  }

  function renderContext() {
    const data = state.context
    statusBox.textContent = ''
    const status = document.createElement('span')
    status.className = `north-ai-status ${data?.qualityStatus || 'unavailable'}`
    status.textContent = statusLabel(data?.qualityStatus)
    statusBox.appendChild(status)
    if (data?.businessDate) {
      const date = document.createElement('span')
      date.className = 'north-ai-status'
      date.textContent = `业务日期 ${data.businessDate}`
      statusBox.appendChild(date)
    }
    if (data?.projectDataReady === false) {
      const project = document.createElement('span')
      project.className = 'north-ai-status unavailable'
      project.textContent = '项目数据暂不可用'
      statusBox.appendChild(project)
    }
    suggestionsBox.textContent = ''
    ;(data?.suggestedQuestions || []).forEach(question => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'north-ai-chip'
      button.textContent = question
      button.addEventListener('click', () => ask(question))
      suggestionsBox.appendChild(button)
    })
  }

  async function loadContext() {
    try {
      const response = await fetch('/api/ai/assistant/context', { headers: authHeaders() })
      if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录驾驶舱' : '数据状态读取失败')
      state.context = await response.json()
      renderContext()
    } catch (error) {
      state.context = { qualityStatus: 'unavailable', suggestedQuestions: ['华北累计回款完成情况怎么样？'] }
      renderContext()
      addMessage('assistant', error.message || '暂时无法读取数据状态，请稍后重试。', { qualityStatus: 'unavailable' })
    }
  }

  // 证据仍由后端校验和返回，但用户界面只展示业务结论与建议。
  function displayAnswerText(text) {
    return String(text || '')
      .split('\n')
      .filter(line => !/^\s*(?:可信)?来源\s*[:：]/.test(line))
      .filter(line => !/^\s*限制说明\s*[:：]/.test(line))
      .filter(line => !/^\s*(?:知识口径|知识依据|标准依据|制度依据)\s*[:：]/.test(line))
      .join('\n')
      .replace(/\s*\[K\d+\]/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function mainAnswerText(text, opinion) {
    const visible = displayAnswerText(text)
    if (!opinion || typeof opinion !== 'object') return visible
    if (/^(?:异常重点|三个优先动作)\s*(?:\n|$)/.test(visible)) return ''
    const opinionMarker = visible.search(/(?:^|\n)\s*(?:AI判断|异常判断|AI意见|管理意见)\s*[:：]?/)
    if (opinionMarker >= 0) return visible.slice(0, opinionMarker).trim()
    return visible
  }

  function appendAiOpinion(wrapper, opinion) {
    if (!opinion || typeof opinion !== 'object') return
    const judgement = displayAnswerText(opinion.judgement)
    const recommendations = displayAnswerText(opinion.recommendations)
    if (!judgement && !recommendations) return

    const card = document.createElement('section')
    card.className = 'north-ai-opinion'
    card.setAttribute('role', 'note')
    card.setAttribute('aria-label', 'AI意见')

    const header = document.createElement('div')
    header.className = 'north-ai-opinion-header'
    const title = document.createElement('strong')
    title.textContent = 'AI意见'
    const nature = document.createElement('span')
    nature.textContent = '辅助判断'
    header.append(title, nature)
    card.appendChild(header)

    if (judgement) {
      const section = document.createElement('div')
      section.className = 'north-ai-opinion-section'
      const heading = document.createElement('h4')
      heading.textContent = '经营判断'
      const content = document.createElement('p')
      content.textContent = judgement
      section.append(heading, content)
      card.appendChild(section)
    }
    if (recommendations) {
      const section = document.createElement('div')
      section.className = 'north-ai-opinion-section north-ai-opinion-actions'
      const heading = document.createElement('h4')
      heading.textContent = '建议动作'
      const content = document.createElement('p')
      content.textContent = recommendations
      section.append(heading, content)
      card.appendChild(section)
    }

    const basis = opinion.basis && typeof opinion.basis === 'object' ? opinion.basis : {}
    const sources = Array.isArray(basis.sources) ? basis.sources.map(String).filter(Boolean) : []
    const limitations = Array.isArray(opinion.limitations) ? opinion.limitations.map(String).filter(Boolean) : []
    if (basis.businessDate || sources.length || limitations.length) {
      const details = document.createElement('details')
      details.className = 'north-ai-opinion-evidence'
      const summary = document.createElement('summary')
      summary.textContent = '查看依据与限制'
      details.appendChild(summary)
      const evidence = document.createElement('p')
      evidence.textContent = [
        basis.businessDate ? `业务日期 ${basis.businessDate}` : '',
        sources.length ? `依据 ${sources.join('、')}` : '',
        limitations.length ? `限制 ${limitations.join('；')}` : '',
      ].filter(Boolean).join(' · ')
      details.appendChild(evidence)
      card.appendChild(details)
    }

    const disclaimer = document.createElement('p')
    disclaimer.className = 'north-ai-opinion-disclaimer'
    disclaimer.textContent = String(opinion.disclaimer || 'AI意见用于经营分析和核查提示，不替代业务确认或审批结论。')
    card.appendChild(disclaimer)
    wrapper.appendChild(card)
  }

  // 名称存在多个匹配时直接给出可操作候选，避免让用户复制完整名称重问。
  function appendCenterChoices(wrapper, candidates) {
    const entries = [...new Set((Array.isArray(candidates) ? candidates : [])
      .map(candidate => String(candidate || '').trim())
      .filter(Boolean))]
    if (!entries.length) return

    const choices = document.createElement('div')
    choices.className = 'north-ai-center-choices'
    choices.setAttribute('role', 'group')
    choices.setAttribute('aria-label', '请选择服务中心')

    const heading = document.createElement('p')
    heading.className = 'north-ai-center-choices-title'
    heading.textContent = '请选择要查询的服务中心'
    choices.appendChild(heading)

    entries.forEach(candidate => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'north-ai-center-choice'
      button.textContent = candidate
      button.addEventListener('click', () => ask(`${candidate}数据`))
      choices.appendChild(button)
    })
    wrapper.appendChild(choices)
  }

  // 同名或近似标准存在多个有效版本时，由用户明确选择，AI不代替用户猜测适用范围。
  function appendKnowledgeChoices(wrapper, candidates) {
    const entries = (Array.isArray(candidates) ? candidates : [])
      .filter(candidate => candidate && typeof candidate === 'object' && candidate.title && candidate.question)
    if (!entries.length) return

    const choices = document.createElement('div')
    choices.className = 'north-ai-center-choices north-ai-knowledge-choices'
    choices.setAttribute('role', 'group')
    choices.setAttribute('aria-label', '请选择知识标准')

    const heading = document.createElement('p')
    heading.className = 'north-ai-center-choices-title'
    heading.textContent = '找到多个有效标准，请选择'
    choices.appendChild(heading)

    entries.forEach(candidate => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'north-ai-center-choice north-ai-knowledge-choice'
      button.textContent = `${candidate.title} · 版本 ${candidate.version || '未标注'}${candidate.scope ? ` · ${candidate.scope}` : ''}`
      button.addEventListener('click', () => ask(candidate.question))
      choices.appendChild(button)
    })
    wrapper.appendChild(choices)
  }

  // 回答后围绕当前中心继续追问，避免用户重复输入完整名称。
  function appendCenterFollowUps(wrapper, centerPayment) {
    const center = String(centerPayment?.center || '').trim()
    if (!center) return
    const followUps = [
      ['看未达标指标', `${center}哪些指标没达标`],
      ['分析异常重点', `${center}的异常重点是什么`],
      ['给三个优先动作', `${center}给我三个优先动作`],
    ]
    const actions = document.createElement('div')
    actions.className = 'north-ai-center-choices north-ai-follow-ups'
    actions.setAttribute('role', 'group')
    actions.setAttribute('aria-label', '继续询问当前服务中心')
    const heading = document.createElement('p')
    heading.className = 'north-ai-center-choices-title'
    heading.textContent = '继续问'
    actions.appendChild(heading)
    followUps.forEach(([label, question]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'north-ai-center-choice'
      button.textContent = label
      button.addEventListener('click', () => ask(question))
      actions.appendChild(button)
    })
    wrapper.appendChild(actions)
  }

  function addMessage(role, text, meta = {}) {
    const wrapper = document.createElement('div')
    wrapper.className = `north-ai-message north-ai-message-${role}${meta.loading ? ' north-ai-message-loading' : ''}`
    wrapper.setAttribute('role', 'article')
    const bubble = document.createElement('div')
    bubble.className = 'north-ai-bubble'
    bubble.textContent = role === 'assistant' ? mainAnswerText(text, meta.aiOpinion) : text
    if (bubble.textContent) wrapper.appendChild(bubble)
    if (role === 'assistant' && !meta.loading) {
      appendAiOpinion(wrapper, meta.aiOpinion)
      const details = document.createElement('div')
      details.className = 'north-ai-meta'
      const quality = document.createElement('span')
      quality.className = meta.qualityStatus || 'unavailable'
      quality.textContent = meta.errorCode === 'CENTER_PAYMENT_NOT_RESOLVED'
        ? '服务中心名称待确认'
        : statusLabel(meta.qualityStatus)
      details.appendChild(quality)
      if (meta.businessDate) {
        const date = document.createElement('span')
        date.textContent = `业务日期 ${meta.businessDate}`
        details.appendChild(date)
      }
      if (meta.errorLabel && meta.errorLabel !== quality.textContent) {
        const errorState = document.createElement('span')
        errorState.className = 'unavailable'
        errorState.textContent = meta.errorLabel
        details.appendChild(errorState)
      }
      wrapper.appendChild(details)
      appendCenterChoices(wrapper, meta.centerPaymentCandidates)
      appendKnowledgeChoices(wrapper, meta.knowledgeChoices)
      appendCenterFollowUps(wrapper, meta.centerPayment)
    }
    messagesBox.appendChild(wrapper)
    root.classList.add('has-messages')
    scrollToBottom()
    return wrapper
  }

  async function ask(rawQuestion) {
    const question = String(rawQuestion || '').trim()
    if (!question || state.busy) return
    state.busy = true
    sendButton.disabled = true
    input.disabled = true
    addMessage('user', question)
    state.messages.push({ role: 'user', content: question })
    input.value = ''
    input.style.height = 'auto'
    const loading = addMessage('assistant', '正在检索已批准知识并核对可信事实', { loading: true })
    try {
      const response = await fetch('/api/ai/assistant/ask', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ question, topic: state.lastTopic, history: state.messages.slice(-6) }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        loading.remove()
        const meta = responseErrorMeta(data, response.status)
        addMessage('assistant', data.error || `请求失败（${response.status}）`, meta)
        return
      }
      loading.remove()
      addMessage('assistant', data.answer, data)
      state.lastTopic = data.topic || ''
      state.messages.push({ role: 'assistant', content: data.answer })
      if (state.messages.length > 12) state.messages = state.messages.slice(-12)
    } catch (error) {
      loading.remove()
      addMessage('assistant', error.message || '暂时无法回答，请稍后重试。', { qualityStatus: 'unavailable' })
    } finally {
      state.busy = false
      sendButton.disabled = false
      input.disabled = false
      input.focus()
    }
  }

  launcher.addEventListener('click', open)
  closeButton.addEventListener('click', close)
  overlay.addEventListener('click', event => { if (event.target === overlay) close() })
  panel.addEventListener('click', event => event.stopPropagation())
  form.addEventListener('submit', event => { event.preventDefault(); ask(input.value) })
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ask(input.value) }
  })
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`
  })
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.open) close() })
  window.addEventListener('popstate', syncRoute)
  const originalPush = history.pushState
  const originalReplace = history.replaceState
  history.pushState = function (...args) { const result = originalPush.apply(this, args); queueMicrotask(syncRoute); return result }
  history.replaceState = function (...args) { const result = originalReplace.apply(this, args); queueMicrotask(syncRoute); return result }
  syncRoute()
})()
