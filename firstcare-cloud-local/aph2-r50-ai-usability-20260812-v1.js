/* R50：AI 使用链路收口。只增强入口、门禁引导与可恢复状态，不改业务数据与 API。 */
(() => {
  'use strict'

  const RELEASE = 'r50-ai-usability-20260812-v1'
  const ASSISTANT_ID = 'north-ai-assistant'
  const APP_ROUTES = new Set([
    '/', '/command', '/projects', '/payment', '/daily', '/collection', '/arrears',
    '/ai-alerts', '/ai-report', '/import', '/review', '/system', '/admin', '/tasks',
  ])
  const CONTEXTUAL_ROUTES = new Set(['/ai-alerts', '/ai-report'])
  const QUICK_QUESTIONS = [
    '当前经营数据反映出哪些异常？',
    '当前有哪些数据质量问题？',
    '华北累计回款完成情况怎么样？',
  ]
  let scheduled = false
  let started = false

  const route = () => window.location.pathname.replace(/\/+$/, '') || '/'
  const text = node => String(node?.textContent || '').replace(/\s+/g, ' ').trim()

  function assistantElements() {
    const root = document.getElementById(ASSISTANT_ID)
    return {
      root,
      launcher: root?.querySelector('.north-ai-launcher'),
      overlay: root?.querySelector('.north-ai-overlay'),
      close: root?.querySelector('.north-ai-close'),
      input: root?.querySelector('.north-ai-input'),
      form: root?.querySelector('.north-ai-composer'),
      messages: root?.querySelector('.north-ai-messages'),
    }
  }

  function syncAssistantEntry() {
    const { root, launcher } = assistantElements()
    if (!root || !launcher) return false

    const current = route()
    const visible = current !== '/login'
      && (APP_ROUTES.has(current) || current.startsWith('/projects/'))
    launcher.hidden = !visible
    launcher.toggleAttribute('hidden', !visible)
    launcher.setAttribute('aria-label', '打开华北经营助手')
    launcher.title = CONTEXTUAL_ROUTES.has(current)
      ? '项目类 AI 当前受真实性门禁限制；仍可查询回款、收缴、欠费和数据质量'
      : '查询已发布的经营数据、口径与异常'
    root.dataset.r50AiUsability = RELEASE
    document.body?.setAttribute('data-r50-ai-usability', RELEASE)
    return true
  }

  function openAssistant() {
    const { launcher, overlay, input } = assistantElements()
    if (!launcher || !overlay) return false
    if (overlay.getAttribute('aria-hidden') === 'true') {
      launcher.click()
      // 旧助手在非首页打开后会立即执行 close()；R50 在同一动作末尾恢复对话框，不改路由。
      if (overlay.getAttribute('aria-hidden') === 'true') {
        overlay.classList.add('is-open')
        overlay.setAttribute('aria-hidden', 'false')
        overlay.inert = false
        overlay.removeAttribute('inert')
        document.documentElement.style.overflow = 'hidden'
      }
    }
    // R45 的 aria-hidden 观察器会在本动作的微任务中设置 inert；进入下一帧后再确保打开态一次。
    window.requestAnimationFrame(() => {
      if (!overlay.classList.contains('is-open') || overlay.getAttribute('aria-hidden') !== 'false') return
      overlay.inert = false
      overlay.removeAttribute('inert')
      input?.focus()
    })
    window.setTimeout(() => input?.focus(), 260)
    return true
  }

  function submitQuestion(question) {
    const { input, form } = assistantElements()
    if (!input || !form || !openAssistant()) return
    window.setTimeout(() => {
      input.value = question
      input.dispatchEvent(new Event('input', { bubbles: true }))
      if (typeof form.requestSubmit === 'function') form.requestSubmit()
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    }, 280)
  }

  function actionButton(label, onClick, className = '') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `aph-r50-ai-action ${className}`.trim()
    button.textContent = label
    button.addEventListener('click', onClick)
    return button
  }

  function enhanceGate(gate, kind) {
    if (!(gate instanceof HTMLElement)) return
    gate.dataset.r50AiGate = kind
    if (gate.querySelector(':scope > .aph-r50-ai-actions')) return

    const actions = document.createElement('div')
    actions.className = 'aph-r50-ai-actions'
    actions.setAttribute('aria-label', '可用的下一步')
    actions.append(actionButton('询问已发布经营数据', openAssistant, 'is-primary'))
    actions.append(actionButton('查看数据接入状态', () => {
      window.location.assign('/import')
    }))
    gate.append(actions)

    const paragraph = gate.querySelector('p')
    const helper = document.createElement('p')
    helper.className = 'aph-r50-ai-gate-helper'
    helper.textContent = kind === 'report'
      ? '项目类月报保持未生成；回款、收缴、欠费和数质量查询仍可使用。'
      : '项目类预警保持未发布；可继续查询已通过质量门禁的经营事实。'
    paragraph?.insertAdjacentElement('afterend', helper)
  }

  function ensureAssistantRecovery() {
    const { messages } = assistantElements()
    if (!messages) return

    messages.querySelectorAll('.north-ai-message-assistant').forEach(message => {
      if (!(message instanceof HTMLElement) || message.dataset.r50Recovery === '1') return
      const copy = text(message.querySelector('.north-ai-bubble'))
      const isProjectGate = /PROJECT_DATA_QUALITY_BLOCKED|项目经营数据尚未通过真实性门禁|真实项目经营数据尚未接入/.test(copy)
      const isRetryable = /请稍后再试|请重新登录|请求失败|数据状态读取失败|提问过于频繁/.test(copy)
      if (!isProjectGate && !isRetryable) return

      const recovery = document.createElement('div')
      recovery.className = 'aph-r50-ai-recovery'
      recovery.setAttribute('role', 'group')
      recovery.setAttribute('aria-label', isProjectGate ? '切换到已发布数据' : '重试操作')
      if (isProjectGate) {
        const note = document.createElement('p')
        note.textContent = '项目类问题暂不生成结论。你可继续查询已发布数据：'
        recovery.append(note)
        QUICK_QUESTIONS.forEach(question => {
          recovery.append(actionButton(question, () => submitQuestion(question)))
        })
      } else {
        recovery.append(actionButton('重新提交', () => {
          const userMessage = [...messages.querySelectorAll('.north-ai-message-user .north-ai-bubble')].at(-1)
          if (userMessage) submitQuestion(text(userMessage))
        }, 'is-primary'))
      }
      message.append(recovery)
      message.dataset.r50Recovery = '1'
    })
  }

  function apply() {
    scheduled = false
    if (!syncAssistantEntry()) return
    enhanceGate(document.querySelector('.aph-alerts-gate'), 'alerts')
    enhanceGate(document.querySelector('.aph-report-gate'), 'report')
    ensureAssistantRecovery()
    const { overlay } = assistantElements()
    if (overlay?.classList.contains('is-open') && overlay.getAttribute('aria-hidden') === 'false') {
      overlay.inert = false
      overlay.removeAttribute('inert')
    }
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(apply)
  }

  function start() {
    if (started) return
    started = true
    schedule()
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
    window.addEventListener('popstate', schedule)
    window.addEventListener('cockpit:navigation', schedule)
    window.addEventListener('aph:project-gate', schedule)
    document.addEventListener('click', event => {
      const close = event.target instanceof Element ? event.target.closest('.north-ai-close') : null
      if (close) {
        const overlay = close.closest('.north-ai-overlay')
        if (overlay) {
          window.setTimeout(() => {
            overlay.classList.remove('is-open')
            overlay.setAttribute('aria-hidden', 'true')
            overlay.inert = true
            overlay.setAttribute('inert', '')
            document.documentElement.style.overflow = ''
            syncAssistantEntry()
          }, 0)
        }
      }
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (link && new URL(link.href, location.href).origin === location.origin) window.setTimeout(schedule, 0)
    }, true)
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  if (document.readyState !== 'loading') start()
})()
