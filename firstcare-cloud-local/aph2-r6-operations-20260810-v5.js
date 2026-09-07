(() => {
  'use strict'

  const RELEASE = 'r6-operations-20260810-v5'
  const API = '/api/command/data-reliability'
  let requestId = 0
  let resizeObserver = null
  let freshnessResizeObserver = null
  let freshnessObservedPanel = null
  let freshnessObservedSlot = null

  const escapeHtml = value => String(value ?? '—')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

  function tone(code) {
    if (code === 'complete') return 'success'
    if (code === 'failed') return 'danger'
    if (code === 'partial') return 'warning'
    return 'neutral'
  }

  function commandMain() {
    if (window.location.pathname !== '/command') return null
    return document.querySelector('#main-content')
  }

  function cleanup() {
    requestId += 1
    document.querySelector('body > [data-r6-governance]')?.remove()
    document.querySelector('[data-r6-governance-slot]')?.remove()
    resizeObserver?.disconnect()
    resizeObserver = null
  }

  function removeOutsideCommand() {
    if (window.location.pathname !== '/command') cleanup()
  }

  function ensureSlot(main) {
    let slot = main.querySelector('[data-r6-governance-slot]')
    if (slot) return slot
    slot = document.createElement('div')
    slot.setAttribute('data-r6-governance-slot', RELEASE)
    slot.className = 'r5-governance-slot'
    slot.setAttribute('aria-hidden', 'true')
    const sections = [...main.querySelectorAll(':scope > section')]
    const anchor = sections.find(node => /今日经营判断|经营判断/.test(node.textContent || '')) || sections[0]
    if (anchor) anchor.insertAdjacentElement('afterend', slot)
    else main.prepend(slot)
    return slot
  }

  function syncGeometry(section, slot) {
    if (!section?.isConnected || !slot?.isConnected || window.location.pathname !== '/command') return
    const rect = slot.getBoundingClientRect()
    if (rect.width <= 0) return
    section.style.left = `${Math.round(rect.left + window.scrollX)}px`
    section.style.top = `${Math.round(rect.top + window.scrollY)}px`
    section.style.width = `${Math.round(rect.width)}px`
    const height = Math.ceil(section.getBoundingClientRect().height)
    if (height > 0) slot.style.height = `${height}px`
  }

  function ensureMount() {
    const main = commandMain()
    if (!main) return null
    document.querySelectorAll('[data-r6-governance]').forEach(node => {
      if (node.parentElement !== document.body) node.remove()
    })
    const slot = ensureSlot(main)
    let section = document.querySelector('body > [data-r6-governance]')
    if (!section) {
      section = document.createElement('section')
      section.setAttribute('data-r6-governance', RELEASE)
      section.className = 'r5-governance-section'
      section.setAttribute('aria-live', 'polite')
      section.innerHTML = '<div class="r5-governance-loading">正在核验正式发布与质量责任状态…</div>'
      document.body.appendChild(section)
    }
    if (!resizeObserver && 'ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => syncGeometry(section, slot))
      resizeObserver.observe(section)
    }
    window.requestAnimationFrame(() => syncGeometry(section, slot))
    return { section, slot }
  }

  function renderSource(source) {
    return `<div class="r5-source-chip">
      <span>${escapeHtml(source.name || source.sourceKey)}</span>
      <b>${escapeHtml(source.businessDate)}</b>
      <small>连接：${escapeHtml(source.status === 'failed' ? '异常' : source.status === 'unknown' ? '未知' : '已连接')} · 时效：${escapeHtml(source.businessDate || '未知')}</small>
      <small>${escapeHtml(source.message || '来源状态未知')}</small>
    </div>`
  }

  function renderCase(row) {
    const timing = row.timing || {}
    const timingTone = timing.isOverdue ? 'danger' : timing.isDueSoon ? 'warning' : 'neutral'
    return `<li>
      <div><b>${escapeHtml(row.title)}</b><span>${escapeHtml(row.owner || '待认领')}</span></div>
      <div class="r5-case-due ${timingTone}"><span>${escapeHtml(row.due_date || '—')}</span><small>${escapeHtml(timing.timingLabel || '待确定')}</small></div>
    </li>`
  }

  function render(data, section, slot) {
    const publication = data?.publication || {}
    const cases = data?.qualityCases || {}
    const publicationTone = tone(publication.code)
    const sources = Array.isArray(publication.sources) ? publication.sources : []
    const rows = Array.isArray(cases.rows) ? cases.rows : []
    section.innerHTML = `<div class="r5-governance-head">
      <div><span>R6 · DATA GOVERNANCE</span><h2>可信数据与责任闭环</h2></div>
      <a href="/admin/#quality">进入真实性中心 →</a>
    </div>
    <div class="r5-governance-grid">
      <article class="r5-governance-card ${publicationTone}">
        <header><div><span>正式发布状态</span><h3>${escapeHtml(publication.label || '结果未知')}</h3></div><b>${escapeHtml(publication.businessDate)}</b></header>
        <p>${escapeHtml(publication.summary || '没有足够证据判断正式发布是否完成。')}</p>
        <div class="r5-publication-dates"><div><span>业务数据日期</span><b>${escapeHtml(publication.businessDate)}</b></div><div><span>正式批次日期</span><b>${escapeHtml(publication.officialBusinessDate)}</b></div></div>
        <div class="r5-source-list">${sources.length ? sources.map(renderSource).join('') : '<span class="r5-empty">来源证据不可用</span>'}</div>
      </article>
      <article class="r5-governance-card responsibilities">
        <header><div><span>质量责任事项</span><h3>${cases.total ?? '—'}项未闭环</h3></div><b>${cases.overdue ?? '—'}项超期</b></header>
        <div class="r5-responsibility-kpis"><div><span>待认领</span><b>${cases.unassigned ?? '—'}</b></div><div><span>即将到期</span><b>${cases.dueSoon ?? '—'}</b></div><div><span>待复核</span><b>${cases.review ?? '—'}</b></div></div>
        ${rows.length ? `<ul class="r5-case-list">${rows.map(renderCase).join('')}</ul>` : '<p class="r5-empty">当前没有可读取的未闭环责任事项。</p>'}
      </article>
    </div>`
    window.requestAnimationFrame(() => syncGeometry(section, slot))
  }

  function renderUnavailable(section, slot, message) {
    section.innerHTML = `<div class="r5-governance-head"><div><span>R6 · DATA GOVERNANCE</span><h2>可信数据与责任闭环</h2></div><a href="/admin/#quality">进入真实性中心 →</a></div>
      <div class="r5-governance-unavailable"><b>结果未知</b><p>${escapeHtml(message || '责任与发布状态接口暂不可用；未将未知值显示为0。')}</p></div>`
    window.requestAnimationFrame(() => syncGeometry(section, slot))
  }

  async function load() {
    removeOutsideCommand()
    const mount = ensureMount()
    if (!mount) return false
    const { section, slot } = mount
    const currentRequest = ++requestId
    const token = localStorage.getItem('cockpit_token') || localStorage.getItem('token') || ''
    const headers = { Accept: 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    try {
      const response = await window.fetch(API, { headers })
      if (!response.ok) throw new Error(`状态接口返回${response.status}`)
      const data = await response.json()
      if (currentRequest !== requestId || window.location.pathname !== '/command') return true
      render(data, section, slot)
    } catch (error) {
      if (currentRequest === requestId && window.location.pathname === '/command') renderUnavailable(section, slot, error?.message)
    }
    return true
  }

  function setAuthRouteState() {
    const login = window.location.pathname === '/login'
    document.body.classList.toggle('aph-auth-route', login)
    document.querySelectorAll('.aph-exact-sidebar,.aph-page-tabs,.aph-mobile-primary-nav,.aph-mobile-more-drawer,#north-ai-assistant').forEach(node => {
      if (login && !node.hasAttribute('data-r6-auth-hidden')) {
        node.setAttribute('hidden', '')
        node.setAttribute('aria-hidden', 'true')
        if ('inert' in node) node.inert = true
        node.setAttribute('data-r6-auth-hidden', 'true')
      } else if (!login && node.hasAttribute('data-r6-auth-hidden')) {
        node.removeAttribute('hidden')
        node.removeAttribute('aria-hidden')
        if ('inert' in node) node.inert = false
        node.removeAttribute('data-r6-auth-hidden')
      }
    })
  }

  function ensureCollectionTitle() {
    const main = document.querySelector('#main-content')
    if (window.location.pathname !== '/collection' || !main || main.querySelector('[data-r6-mobile-title]')) return
    const title = document.createElement('h1')
    title.dataset.r6MobileTitle = 'true'
    title.className = 'r6-mobile-page-title'
    title.textContent = '收缴率明细'
    main.prepend(title)
  }

  function clarifyHomeGrouping() {
    if (window.location.pathname !== '/') return
    document.querySelectorAll('span,div').forEach(node => {
      if (node.children.length !== 0 || (node.textContent || '').trim() !== '片区数 / 服务中心数') return
      node.textContent = '经营分组 / 服务中心数'
      let card = node.parentElement
      while (card && card !== document.body && !/9\s*\/\s*56/.test(card.textContent || '')) card = card.parentElement
      if (!card || card === document.body) return
      let note = card.querySelector('small')
      if (!note) note = [...card.querySelectorAll('div,span,p')].find(item => /朝阳.*京东.*海淀/.test(item.textContent || '')) || null
      if (note) note.textContent = '6个地理片区 + 3个特殊分组（公司 / 保洁 / 已撤场）'
    })
  }

  function sourceFreshnessMain() {
    if (!['/', '/command', '/collection'].includes(window.location.pathname)) return null
    return document.querySelector('#main-content')
  }

  function cleanupSourceFreshnessLayout() {
    document.querySelector('[data-r6-source-freshness-slot]')?.remove()
    const panel = document.querySelector('body > .aph-source-freshness')
    if (panel) {
      panel.classList.remove('r6-source-freshness-relocated')
      panel.style.removeProperty('left')
      panel.style.removeProperty('top')
      panel.style.removeProperty('width')
    }
    freshnessResizeObserver?.disconnect()
    freshnessResizeObserver = null
    freshnessObservedPanel = null
    freshnessObservedSlot = null
  }

  function ensureSourceFreshnessSlot(main) {
    let slot = main.querySelector('[data-r6-source-freshness-slot]')
    if (!slot) {
      slot = document.createElement('div')
      slot.dataset.r6SourceFreshnessSlot = RELEASE
      slot.className = 'r6-source-freshness-slot'
      slot.setAttribute('aria-hidden', 'true')
    }
    if (window.location.pathname === '/') {
      const root = main.querySelector('.aph-home-reflow')
      const region = root?.querySelector(':scope > .aph-home-region-grid')
      if (root && region && (slot.parentElement !== root || slot.nextElementSibling !== region)) region.insertAdjacentElement('beforebegin', slot)
      else if (root && slot.parentElement !== root) root.append(slot)
      else if (!root && slot.parentElement !== main) main.append(slot)
    } else {
      const container = main.firstElementChild || main
      const sections = [...container.querySelectorAll(':scope > section')]
      const anchor = sections[0]
      if (anchor && (slot.parentElement !== container || slot.previousElementSibling !== anchor)) anchor.insertAdjacentElement('afterend', slot)
      else if (!anchor && slot.parentElement !== container) container.prepend(slot)
    }
    return slot
  }

  function syncSourceFreshnessGeometry(panel, slot) {
    if (!panel?.isConnected || !slot?.isConnected || !sourceFreshnessMain()) return
    const rect = slot.getBoundingClientRect()
    if (rect.width <= 0) return
    panel.style.left = `${Math.round(rect.left + window.scrollX)}px`
    panel.style.top = `${Math.round(rect.top + window.scrollY)}px`
    panel.style.width = `${Math.round(rect.width)}px`
    const height = Math.ceil(panel.getBoundingClientRect().height)
    if (height > 0) slot.style.height = `${height}px`
  }

  function relocateSourceFreshness() {
    const main = sourceFreshnessMain()
    if (!main) {
      cleanupSourceFreshnessLayout()
      return
    }
    const panel = document.querySelector('body > .aph-source-freshness')
    if (!panel) return
    const slot = ensureSourceFreshnessSlot(main)
    panel.classList.add('r6-source-freshness-relocated')
    if ('ResizeObserver' in window && (freshnessObservedPanel !== panel || freshnessObservedSlot !== slot)) {
      freshnessResizeObserver?.disconnect()
      freshnessResizeObserver = new ResizeObserver(() => syncSourceFreshnessGeometry(panel, slot))
      freshnessResizeObserver.observe(panel)
      freshnessObservedPanel = panel
      freshnessObservedSlot = slot
    }
    window.requestAnimationFrame(() => syncSourceFreshnessGeometry(panel, slot))
  }

  function addProjectMappingAction() {
    if (window.location.pathname !== '/projects') return
    document.querySelectorAll('.aph-project-kpis article').forEach(card => {
      if (!/经营数据已关联/.test(card.textContent || '') || card.querySelector('[data-r6-mapping-link]')) return
      const link = document.createElement('a')
      link.dataset.r6MappingLink = 'true'
      link.href = '/admin/#mappings'
      link.textContent = '查看未关联映射 →'
      card.appendChild(link)
    })
  }

  function sortableValue(cell) {
    const text = (cell?.textContent || '').trim()
    if (!text || text === '—') return { missing: true, value: 0 }
    const numeric = Number(text.replaceAll(',', '').replace(/[万%+\s]/g, ''))
    return Number.isFinite(numeric) ? { missing: false, value: numeric } : { missing: false, value: text }
  }

  function enhanceLongTables() {
    if (!['/payment', '/projects'].includes(window.location.pathname)) return
    document.querySelectorAll('#main-content table').forEach((table, tableIndex) => {
      table.querySelectorAll('thead th').forEach((th, index) => {
        if (th.dataset.r6SortReady || /操作/.test(th.textContent || '')) return
        th.dataset.r6SortReady = 'true'
        const label = (th.textContent || '').trim()
        if (!label) return
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'r6-sort-button'
        button.textContent = `${label} ↕`
        button.setAttribute('aria-label', `按${label}排序`)
        th.replaceChildren(button)
        button.addEventListener('click', () => {
          const direction = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending'
          table.querySelectorAll('thead th').forEach(node => node.setAttribute('aria-sort', 'none'))
          th.setAttribute('aria-sort', direction)
          const body = table.tBodies[0]
          if (!body) return
          const rows = [...body.rows]
          rows.sort((left, right) => {
            const a = sortableValue(left.cells[index])
            const b = sortableValue(right.cells[index])
            if (a.missing !== b.missing) return a.missing ? 1 : -1
            const result = typeof a.value === 'number' && typeof b.value === 'number'
              ? a.value - b.value
              : String(a.value).localeCompare(String(b.value), 'zh-CN')
            return direction === 'ascending' ? result : -result
          }).forEach(row => body.appendChild(row))
          const url = new URL(window.location.href)
          url.searchParams.set('sort', `${tableIndex}:${index}:${direction === 'ascending' ? 'asc' : 'desc'}`)
          history.replaceState(history.state, '', `${url.pathname}${url.search}`)
        })
      })
    })
  }

  function applyPageFixes() {
    setAuthRouteState()
    ensureCollectionTitle()
    clarifyHomeGrouping()
    relocateSourceFreshness()
    addProjectMappingAction()
    enhanceLongTables()
  }

  function schedule() {
    applyPageFixes()
    cleanup()
    window.setTimeout(() => {
      applyPageFixes()
      cleanup()
    }, 1600)
  }

  window.addEventListener('DOMContentLoaded', schedule, { once: true })
  window.addEventListener('popstate', schedule)
  window.addEventListener('cockpit:navigation', schedule)
  window.addEventListener('resize', () => {
    const section = document.querySelector('body > [data-r6-governance]')
    const slot = document.querySelector('[data-r6-governance-slot]')
    if (section && slot) syncGeometry(section, slot)
    const freshness = document.querySelector('body > .aph-source-freshness')
    const freshnessSlot = document.querySelector('[data-r6-source-freshness-slot]')
    if (freshness && freshnessSlot) syncSourceFreshnessGeometry(freshness, freshnessSlot)
  })
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link && new URL(link.href, window.location.href).origin === window.location.origin) window.setTimeout(schedule, 0)
  }, true)
  new MutationObserver(() => applyPageFixes()).observe(document.documentElement, { childList: true, subtree: true })
  if (document.readyState !== 'loading') schedule()
})()
