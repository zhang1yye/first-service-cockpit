(() => {
  'use strict'

  const path = window.location.pathname
  if (path === '/tasks' || path.startsWith('/tasks/')) {
    window.location.replace('/command')
    return
  }

  const nativeFetch = window.fetch.bind(window)
  const retiredReadPaths = [
    '/api/tasks',
    '/api/tasks/supervision/summary',
    '/api/remediation-impact',
  ]
  window.fetch = (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input?.url || ''
    const url = new URL(rawUrl, window.location.origin)
    const method = String(init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase()
    const isRetiredRead = method === 'GET' && retiredReadPaths.some(retired =>
      url.pathname === retired || url.pathname.startsWith(`${retired}/`)
    )
    if (isRetiredRead) return Promise.resolve(new Response(null, { status: 204, statusText: 'No Content' }))
    return nativeFetch(input, init)
  }

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim()
  const taskActionPattern = /(生成|创建|转为|转入|进入|查看|批量生成|去).*(任务|任务闭环)|任务闭环|催办任务|刷新逾期状态/
  const taskSectionPatterns = {
    '/command': [
      /^今日必须处理\s*TOP5/,
      /^任务闭环\s*逾期/,
    ],
    '/ai-report': [
      /^本月复盘证据/,
      /^整改动作与指标成效/,
      /^管理动作\s*当前经营整改任务/,
    ],
  }

  function hide(element) {
    if (!element || element.dataset?.taskRetired === '1') return
    element.dataset.taskRetired = '1'
    element.setAttribute('hidden', '')
    element.setAttribute('aria-hidden', 'true')
    element.style.setProperty('display', 'none', 'important')
  }

  function removeTaskSections(root) {
    const patterns = taskSectionPatterns[path] || []
    if (!patterns.length) return
    root.querySelectorAll('section, article').forEach(section => {
      const text = normalize(section.innerText)
      if (patterns.some(pattern => pattern.test(text))) hide(section)
    })
  }

  function removeTaskControls(root) {
    root.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href') || ''
      if (href === '/tasks' || href.startsWith('/tasks?') || href.startsWith('/tasks/')) hide(link)
    })
    root.querySelectorAll('button, [role="button"]').forEach(control => {
      if (taskActionPattern.test(normalize(control.innerText))) hide(control)
    })
  }

  function cleanPageSpecificContent(root) {
    if (path === '/command') {
      root.querySelectorAll('a, div, article').forEach(element => {
        const text = normalize(element.innerText)
        if (/^数据治理未闭环\b/.test(text) || /^开放修复\b/.test(text)) hide(element)
      })
    }

    if (path === '/projects') {
      root.querySelectorAll('a, button').forEach(element => {
        const text = normalize(element.innerText)
        if (/生成任务|转入任务闭环/.test(text)) hide(element)
      })
    }

    if (path === '/ai-report') {
      const legacyLabels = ['任务总数', '本月新增', '已完成', '处理中', '逾期', '3天到期', '待复核', '闭环率']
      root.querySelectorAll('section, article, div').forEach(element => {
        const text = normalize(element.innerText)
        const hits = legacyLabels.filter(label => text.includes(label)).length
        if (hits < 5 || text.length > 500) return
        const childrenWithHits = [...element.children].filter(child =>
          legacyLabels.some(label => normalize(child.innerText).includes(label))
        )
        if (childrenWithHits.length >= 4) hide(element)
      })
    }

    if (path.startsWith('/projects/')) {
      root.querySelectorAll('button, a').forEach(element => {
        if (/任务/.test(normalize(element.innerText))) hide(element)
      })
    }
  }

  function replaceLegacyCopy(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    for (const node of nodes) {
      const parent = node.parentElement
      if (!parent || parent.closest('[data-task-retired="1"], script, style, noscript')) continue
      let value = node.nodeValue || ''
      value = value
        .replace(/自动任务/g, '数据流水线')
        .replace(/任务闭环/g, '经营跟踪')
        .replace(/未闭环/g, '待处理')
        .replace(/逾期任务/g, '超期事项')
        .replace(/任务/g, '事项')
      if (value !== node.nodeValue) node.nodeValue = value
    }
  }

  let scheduled = false
  function apply() {
    scheduled = false
    const root = document.getElementById('root') || document.body
    removeTaskControls(root)
    removeTaskSections(root)
    cleanPageSpecificContent(root)
    replaceLegacyCopy(root)
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(apply)
  }

  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href^="/tasks"]') : null
    if (!link) return
    event.preventDefault()
    event.stopImmediatePropagation()
    window.location.assign('/command')
  }, true)

  function start() {
    const target = document.documentElement || document
    const observer = new MutationObserver(schedule)
    observer.observe(target, { childList: true, subtree: true })
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true })
    else schedule()
  }

  if (document.documentElement) start()
  else document.addEventListener('readystatechange', start, { once: true })
})()
