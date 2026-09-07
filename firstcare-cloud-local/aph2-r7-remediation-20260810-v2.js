(() => {
  'use strict'

  const RELEASE = 'r7-remediation-20260810-v1'
  const SUMMARY_API = '/api/summary'
  window.__aphR7UnifiedSourceStatus = true
  let summary = null
  let summaryPromise = null
  let scheduled = false

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim()

  function authHeaders() {
    const token = localStorage.getItem('cockpit_token') || localStorage.getItem('token') || ''
    return token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' }
  }

  function dateOnly(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
    return match ? `${match[1]}-${match[2]}-${match[3]}` : '—'
  }

  function loadSummary() {
    if (summaryPromise) return summaryPromise
    summaryPromise = window.fetch(SUMMARY_API, { headers: authHeaders() })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`summary ${response.status}`)))
      .then(data => {
        summary = data
        schedule()
        return data
      })
      .catch(() => null)
    return summaryPromise
  }

  function sourceRows() {
    if (!summary) return []
    return [
      {
        label: 'APH回款',
        state: summary.aphSourceStatus === 'available' ? '已验证' : '暂不可用',
        date: dateOnly(summary.aphBusinessDate),
        tone: summary.aphSourceStatus === 'available' ? 'available' : 'unavailable',
      },
      {
        label: '绿仔收缴',
        state: summary.collectionPublicationStatus === 'published'
          ? '已发布'
          : summary.collectionPublicationStatus === 'blocked' ? '未发布' : '暂不可用',
        date: dateOnly(summary.collectionBusinessDate || summary.collectionExtractedAt),
        tone: summary.collectionPublicationStatus === 'published' ? 'available' : 'unavailable',
      },
    ]
  }

  function updateHeaderStatus() {
    const host = document.querySelector('.aph-header-status')
    const rows = sourceRows()
    if (!host || !rows.length) return
    const signature = JSON.stringify(rows)
    const existing = host.querySelector('[data-r7-unified-source-status]')
    if (existing?.dataset.signature === signature && host.childElementCount === 1) return

    const status = document.createElement('div')
    status.className = 'r7-unified-source-status'
    status.dataset.r7UnifiedSourceStatus = RELEASE
    status.dataset.signature = signature

    const title = document.createElement('span')
    title.className = 'r7-unified-source-title'
    title.textContent = '经营数据分源更新'
    status.append(title)
    rows.forEach(row => {
      const item = document.createElement('span')
      item.className = 'r7-unified-source-item'
      item.dataset.status = row.tone
      item.innerHTML = `<b>${row.label}</b><em>${row.state}</em><time>${row.date}</time>`
      status.append(item)
    })
    host.replaceChildren(status)
    host.classList.remove('r7-source-header-active')
    host.classList.add('r7-unified-source-host')
    host.setAttribute('aria-label', rows.map(row => `${row.label}${row.state}，数据日期${row.date}`).join('；'))
  }

  function fixRetiredTaskEntrypoints() {
    document.querySelectorAll('a[href^="/tasks"]').forEach(link => {
      link.hidden = true
      link.setAttribute('aria-hidden', 'true')
      link.style.setProperty('display', 'none', 'important')
    })
    document.querySelectorAll('a[href="#today-top5"]').forEach(link => {
      link.href = '/admin/#quality'
      link.textContent = '查看质量责任事项'
      link.setAttribute('aria-label', '进入系统管理的数据真实性中心')
    })
  }

  function historyUnavailable() {
    if (window.location.pathname !== '/collection') return false
    const main = document.querySelector('#main-content')
    return /(真实月度历史|真实月度快照).*未接入/.test(normalize(main?.textContent))
  }

  function clarifyUnavailableComparisons() {
    if (!historyUnavailable()) return
    document.querySelectorAll('#main-content span,#main-content div,#main-content p').forEach(node => {
      if (node.children.length) return
      const text = normalize(node.textContent)
      const combinedMatch = text.match(/^(同比|环比)(?:变动|变化)?\s*[+−-]?0(?:\.0+)?\s*(pp|个百分点)$/i)
      const zeroValueMatch = text.match(/^[+−-]?0(?:\.0+)?\s*(pp|个百分点)$/i)
      let comparisonLabel = combinedMatch?.[1] || ''

      if (!comparisonLabel && zeroValueMatch) {
        let scope = node.parentElement
        for (let depth = 0; scope && depth < 4; depth += 1, scope = scope.parentElement) {
          comparisonLabel = normalize(scope.textContent).match(/(同比|环比)(?:变动|变化)?/)?.[1] || ''
          if (comparisonLabel) break
        }
      }

      if (!comparisonLabel) return
      node.textContent = combinedMatch ? `${comparisonLabel} —` : '—'
      node.classList.add('r7-history-unavailable-value')
      node.title = '真实月度历史流水未接入，不生成同比或环比值'
    })
  }

  function moveWithdrawnRowsLast() {
    if (window.location.pathname !== '/collection') return
    document.querySelectorAll('#main-content table tbody').forEach(body => {
      const rows = [...body.rows]
      const withdrawn = rows.filter(row => /已撤场/.test(normalize(row.textContent)))
      if (!withdrawn.length) return
      const firstWithdrawn = rows.findIndex(row => /已撤场/.test(normalize(row.textContent)))
      const activeAfter = firstWithdrawn >= 0 && rows.slice(firstWithdrawn + 1).some(row => !/已撤场/.test(normalize(row.textContent)))
      if (!activeAfter) return
      withdrawn.forEach(row => body.appendChild(row))
    })
  }

  function bindCollectionSortStabilizer() {
    if (window.location.pathname !== '/collection') return
    const main = document.querySelector('#main-content')
    if (!main || main.dataset.r7CollectionSortBound === '1') return
    main.dataset.r7CollectionSortBound = '1'
    main.addEventListener('click', event => {
      if (!event.target.closest('table thead th, table thead button')) return
      window.setTimeout(moveWithdrawnRowsLast, 0)
      window.setTimeout(moveWithdrawnRowsLast, 120)
    }, true)
  }

  function closestPanel(node, requiredLabels = []) {
    let current = node
    while (current && current !== document.body) {
      const text = normalize(current.textContent)
      if (requiredLabels.every(label => text.includes(label)) && ['SECTION', 'ARTICLE'].includes(current.tagName)) return current
      current = current.parentElement
    }
    return null
  }

  function markReviewSnapshotStale() {
    if (window.location.pathname !== '/review') return
    const freshness = document.querySelector('.aph-review-freshness.is-stale')
    if (!freshness) return
    const main = document.querySelector('#main-content')
    const healthHeading = [...(main?.querySelectorAll('h1,h2,h3,h4') || [])].find(node => normalize(node.textContent) === 'AI 审核健康')
    const healthPanel = closestPanel(healthHeading, ['总调用', '成功率'])
    const panelTimestamp = normalize(healthPanel?.textContent).match(/最近调用[：:]\s*([^\s·]+)/)?.[1]
    const freshnessTimestamp = normalize(freshness.textContent).match(/(\d{4}[/-]\d{1,2}[/-]\d{1,2})/)?.[1]
    const raw = panelTimestamp || freshnessTimestamp || '未提供'
    freshness.textContent = `AI最近快照：${raw} · 已过期（仅供历史参考）`

    if (healthPanel) {
      healthPanel.classList.add('r7-stale-snapshot-panel')
      if (!healthPanel.querySelector('[data-r7-stale-note]')) {
        const note = document.createElement('p')
        note.dataset.r7StaleNote = RELEASE
        note.className = 'r7-stale-snapshot-note'
        note.textContent = '以下数字来自最近一次 AI 快照，不代表今日实时状态。'
        healthHeading?.parentElement?.append(note)
      }
      healthPanel.querySelectorAll('span,div,p').forEach(node => {
        if (node.children.length) return
        const text = normalize(node.textContent)
        if (text === '总调用') node.textContent = '最近快照总调用'
        if (text === '成功率') node.textContent = '最近快照成功率'
      })
    }

    const robotHeading = [...(main?.querySelectorAll('h1,h2,h3,h4') || [])].find(node => normalize(node.textContent) === '审核机器人')
    const robotPanel = closestPanel(robotHeading, ['审核机器人'])
    robotPanel?.querySelectorAll('span,div,p').forEach(node => {
      if (node.children.length) return
      const text = normalize(node.textContent)
      if (/^今日\s+\d+/.test(text)) node.textContent = text.replace(/^今日/, '最近快照')
    })
  }

  function apply() {
    updateHeaderStatus()
    fixRetiredTaskEntrypoints()
    clarifyUnavailableComparisons()
    bindCollectionSortStabilizer()
    moveWithdrawnRowsLast()
    markReviewSnapshotStale()
    document.body?.setAttribute('data-r7-remediation', RELEASE)
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(() => {
      scheduled = false
      apply()
    })
  }

  function start() {
    loadSummary()
    schedule()
    new MutationObserver(schedule).observe(document.getElementById('root') || document.documentElement, { childList: true, subtree: true })
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  window.addEventListener('popstate', () => { summaryPromise = null; loadSummary(); schedule() })
  window.addEventListener('cockpit:navigation', schedule)
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link && new URL(link.href, location.href).origin === location.origin) window.setTimeout(schedule, 0)
  }, true)
  if (document.readyState !== 'loading') start()
})()
