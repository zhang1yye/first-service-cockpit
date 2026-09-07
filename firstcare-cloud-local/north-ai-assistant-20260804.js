(() => {
  'use strict'
  const ID = 'north-ai-assistant'
  if (document.getElementById(ID)) return

  const state = { open: false, busy: false, context: null, messages: [], lastTopic: '' }
  const root = document.createElement('div')
  root.id = ID
  root.innerHTML = `
    <button class="north-ai-launcher" type="button" aria-label="打开华北经营助手" aria-haspopup="dialog">
      <span class="north-ai-launcher-mark" aria-hidden="true"></span>
      <span class="north-ai-launcher-copy"><strong>华北经营助手</strong><span>问数据 · 查异常 · 看口径</span></span>
      <span class="north-ai-launcher-dot" aria-hidden="true"></span>
    </button>
    <div class="north-ai-overlay" aria-hidden="true">
      <section class="north-ai-panel" role="dialog" aria-modal="true" aria-labelledby="north-ai-title">
        <header class="north-ai-header">
          <h2 id="north-ai-title" class="north-ai-sr-only">华北经营助手</h2>
          <button class="north-ai-close" type="button" aria-label="关闭华北经营助手">×</button>
        </header>
        <main class="north-ai-conversation" aria-live="polite">
          <section class="north-ai-welcome">
            <div class="north-ai-aph-mark" aria-hidden="true"><span>A</span></div>
            <h3>华北经营助手</h3>
            <p>你好，我是你的华北经营助手，可以帮你查询APH回款执行、绿仔官方收缴率、跨源口径差异和数据质量。</p>
            <div class="north-ai-context-status"><span class="north-ai-status">正在核验数据状态…</span></div>
          </section>
          <div class="north-ai-suggestions"></div>
          <div class="north-ai-messages"></div>
        </main>
        <footer class="north-ai-composer-wrap">
          <form class="north-ai-composer">
            <textarea class="north-ai-input" rows="1" maxlength="500" placeholder="请输入你的问题" aria-label="输入经营问题"></textarea>
            <button class="north-ai-send" type="submit" aria-label="发送问题">➜</button>
          </form>
          <p class="north-ai-disclaimer">AI仅做只读分析，答案附来源、业务日期与质量状态，不创建任务或修改数据。</p>
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

  const token = () => localStorage.getItem('cockpit_token') || ''
  const isHome = () => window.location.pathname === '/' || window.location.pathname === ''
  const authHeaders = () => ({ 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) })
  const statusLabel = status => status === 'verified' ? '数据已验证' : status === 'warning' ? '存在待复核差异' : '部分数据不可用'

  function syncRoute() {
    launcher.hidden = !isHome()
    if (!isHome() && state.open) close()
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

  function addMessage(role, text, meta = {}) {
    const wrapper = document.createElement('div')
    wrapper.className = `north-ai-message north-ai-message-${role}${meta.loading ? ' north-ai-message-loading' : ''}`
    wrapper.setAttribute('role', 'article')
    const bubble = document.createElement('div')
    bubble.className = 'north-ai-bubble'
    bubble.textContent = text
    wrapper.appendChild(bubble)
    if (role === 'assistant' && !meta.loading) {
      const details = document.createElement('div')
      details.className = 'north-ai-meta'
      const quality = document.createElement('span')
      quality.className = meta.qualityStatus || 'unavailable'
      quality.textContent = statusLabel(meta.qualityStatus)
      details.appendChild(quality)
      if (meta.businessDate) {
        const date = document.createElement('span')
        date.textContent = `业务日期 ${meta.businessDate}`
        details.appendChild(date)
      }
      ;(meta.sources || []).forEach(source => {
        const item = document.createElement('span')
        item.className = source.status || ''
        item.textContent = `来源：${source.name}${source.businessDate ? ` · ${source.businessDate}` : ''}`
        details.appendChild(item)
      })
      wrapper.appendChild(details)
      if (meta.limitations?.length) {
        const limitations = document.createElement('div')
        limitations.className = 'north-ai-limitations'
        limitations.textContent = `限制说明：${meta.limitations.join('；')}`
        wrapper.appendChild(limitations)
      }
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
    const loading = addMessage('assistant', '正在核对来源与业务日期', { loading: true })
    try {
      const response = await fetch('/api/ai/assistant/ask', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ question, topic: state.lastTopic, history: state.messages.slice(-6) }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`)
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
