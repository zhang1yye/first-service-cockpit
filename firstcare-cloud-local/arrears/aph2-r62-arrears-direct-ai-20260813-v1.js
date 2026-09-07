/* R62：欠费页进入即显示 AI 分析表单，仅调整前端信息层级。 */
(() => {
  'use strict'

  const byId = (id) => document.getElementById(id)
  const directLabel = '开始AI分析'

  function showCreatePanel() {
    const panel = byId('r55CreatePanel')
    if (!panel) return
    panel.hidden = false
    panel.setAttribute('aria-label', 'AI欠费分析')
    panel.removeAttribute('aria-labelledby')
    byId('r55NewBatch')?.setAttribute('aria-expanded', 'true')
  }

  function normalizeSubmitLabel() {
    const button = byId('r55SubmitBatch')
    const form = byId('r55CreateForm')
    if (!button) return
    if (form?.getAttribute('aria-busy') === 'true') {
      button.setAttribute('aria-label', button.textContent.trim())
      return
    }
    if (button.textContent.trim() === '上传校验并开始AI分析') button.textContent = directLabel
    button.setAttribute('aria-label', button.textContent.trim())
  }

  function updateReadinessIssue() {
    const archive = byId('r55ArchiveState')
    const ai = byId('r55AiState')
    const hasIssue = archive?.classList.contains('is-bad') || ai?.classList.contains('is-bad')
    document.documentElement.dataset.r62ReadinessIssue = hasIssue ? 'true' : 'false'
  }

  function compactCopy() {
    const heading = document.querySelector('.page-heading h1')
    if (heading) heading.textContent = 'AI欠费分析'
    document.title = 'AI欠费分析｜第一服务华北经营驾驶舱'

    const workbench = byId('r55Workbench')
    workbench?.setAttribute('aria-label', 'AI欠费分析')
    workbench?.removeAttribute('aria-labelledby')

    const createTitle = byId('r55CreateTitle')
    if (createTitle) createTitle.textContent = '开始AI分析'
    const taskTitle = byId('r55TaskListTitle')
    if (taskTitle) taskTitle.textContent = '历史分析记录'
  }

  function wrapHistory() {
    const section = document.querySelector('.r55-task-section')
    if (!section || byId('r62History')) return

    section.id = 'r62HistoryPanel'
    const details = document.createElement('details')
    details.id = 'r62History'
    details.className = 'r62-history'

    const summary = document.createElement('summary')
    summary.setAttribute('aria-controls', section.id)
    const label = document.createElement('span')
    label.textContent = '历史分析'
    const count = document.createElement('span')
    count.id = 'r62HistoryCount'
    count.textContent = '读取中'
    summary.append(label, count)

    section.before(details)
    details.append(summary, section)

    const source = byId('r55TaskCount')
    const update = () => {
      const text = source?.textContent?.trim() || '读取中'
      const match = text.match(/\d+\/(\d+)/)
      count.textContent = match ? `${match[1]}条` : text
    }
    update()
    if (source) new MutationObserver(update).observe(source, { childList: true, subtree: true, characterData: true })
  }

  function wrapSecondaryViews() {
    const nav = document.querySelector('.r55-view-nav')
    const shell = byId('r55Shell')
    if (!nav || !shell || byId('r62Views')) return

    const tasks = byId('r55TasksView')
    if (tasks) tasks.textContent = 'AI分析'

    const details = document.createElement('details')
    details.id = 'r62Views'
    details.className = 'r62-views'
    const summary = document.createElement('summary')
    summary.textContent = '经营数据'
    summary.setAttribute('aria-controls', 'r62ViewNavigation')
    nav.id = 'r62ViewNavigation'
    shell.append(details)
    details.append(summary, nav)

    nav.addEventListener('click', (event) => {
      const mode = event.target.closest('[data-r55-mode]')?.dataset.r55Mode
      details.open = mode !== 'tasks'
    })
  }

  function restoreVisibleFocus() {
    window.requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active.getClientRects().length) return
      document.querySelector('#r62History > summary')?.focus({ preventScroll: true })
    })
  }

  function start() {
    document.documentElement.dataset.r62DirectAi = 'true'
    compactCopy()
    wrapHistory()
    wrapSecondaryViews()
    showCreatePanel()
    normalizeSubmitLabel()
    updateReadinessIssue()

    const submit = byId('r55SubmitBatch')
    if (submit) {
      new MutationObserver(normalizeSubmitLabel).observe(submit, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    }

    const readiness = byId('r55Readiness')
    if (readiness) {
      new MutationObserver(updateReadinessIssue).observe(readiness, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
        subtree: true,
        characterData: true,
      })
    }

    byId('r55CloseReview')?.addEventListener('click', () => {
      window.requestAnimationFrame(showCreatePanel)
      restoreVisibleFocus()
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
