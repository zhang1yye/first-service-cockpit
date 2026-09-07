(() => {
  'use strict'

  const RELEASE = 'r5-governance-20260809-v1'
  const API = '/api/command/data-reliability'
  let requestId = 0
  let resizeObserver = null

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
    document.querySelector('body > [data-r5-governance]')?.remove()
    document.querySelector('[data-r5-governance-slot]')?.remove()
    resizeObserver?.disconnect()
    resizeObserver = null
  }

  function removeOutsideCommand() {
    if (window.location.pathname !== '/command') cleanup()
  }

  function ensureSlot(main) {
    let slot = main.querySelector('[data-r5-governance-slot]')
    if (slot) return slot
    slot = document.createElement('div')
    slot.setAttribute('data-r5-governance-slot', RELEASE)
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
    document.querySelectorAll('[data-r5-governance]').forEach(node => {
      if (node.parentElement !== document.body) node.remove()
    })
    const slot = ensureSlot(main)
    let section = document.querySelector('body > [data-r5-governance]')
    if (!section) {
      section = document.createElement('section')
      section.setAttribute('data-r5-governance', RELEASE)
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
      <div><span>R5 · DATA GOVERNANCE</span><h2>可信数据与责任闭环</h2></div>
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
    section.innerHTML = `<div class="r5-governance-head"><div><span>R5 · DATA GOVERNANCE</span><h2>可信数据与责任闭环</h2></div><a href="/admin/#quality">进入真实性中心 →</a></div>
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

  function schedule() {
    removeOutsideCommand()
    if (window.location.pathname !== '/command') return
    let attempt = 0
    const tryLoad = () => {
      attempt += 1
      const main = commandMain()
      if (main?.querySelector('h1') && main.querySelector(':scope > section')) void load()
      else if (attempt < 30) window.setTimeout(tryLoad, 200)
    }
    tryLoad()
    window.setTimeout(() => {
      if (window.location.pathname === '/command') void load()
    }, 1600)
  }

  window.addEventListener('DOMContentLoaded', schedule, { once: true })
  window.addEventListener('popstate', schedule)
  window.addEventListener('cockpit:navigation', schedule)
  window.addEventListener('resize', () => {
    const section = document.querySelector('body > [data-r5-governance]')
    const slot = document.querySelector('[data-r5-governance-slot]')
    if (section && slot) syncGeometry(section, slot)
  })
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link && new URL(link.href, window.location.href).origin === window.location.origin) window.setTimeout(schedule, 0)
  }, true)
  if (document.readyState !== 'loading') schedule()
})()
