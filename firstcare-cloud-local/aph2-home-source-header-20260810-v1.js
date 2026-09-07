(() => {
  'use strict'

  const RELEASE = 'home-source-header-20260810-v2'

  function readSources(panel) {
    return [...panel.querySelectorAll(':scope > article')].map(article => ({
      label: article.querySelector('strong')?.textContent?.trim() || '数据源',
      status: article.querySelector('span')?.textContent?.trim() || '状态未知',
      date: article.querySelector('time')?.textContent?.trim() || '—',
      tone: article.dataset.status || 'unavailable',
    }))
  }

  function cleanup() {
    document.body?.classList.remove('aph-home-source-header')
    const status = document.querySelector('.aph-header-status')
    status?.classList.remove('r7-source-header-active')
    status?.removeAttribute('aria-label')
    status?.querySelector('[data-r7-source-header]')?.remove()
  }

  function render() {
    if (window.__aphR7UnifiedSourceStatus) {
      const status = document.querySelector('.aph-header-status')
      status?.classList.remove('r7-source-header-active')
      status?.querySelector('[data-r7-source-header]')?.remove()
      document.body?.classList.add('aph-home-source-header')
      return
    }
    if (window.location.pathname !== '/') {
      cleanup()
      return
    }
    const status = document.querySelector('.aph-header-status')
    const panel = document.querySelector('body > .aph-source-freshness')
    if (!status || !panel) return
    const sources = readSources(panel)
    if (!sources.length) return
    const signature = JSON.stringify(sources)
    let host = status.querySelector('[data-r7-source-header]')
    if (host?.dataset.signature === signature) return
    if (!host) {
      host = document.createElement('div')
      host.dataset.r7SourceHeader = RELEASE
      host.className = 'r7-header-freshness'
    }
    host.dataset.signature = signature
    const title = document.createElement('span')
    title.className = 'r7-header-freshness-title'
    title.textContent = '经营数据分源更新'
    const separator = document.createElement('i')
    separator.setAttribute('aria-hidden', 'true')
    separator.textContent = '·'
    host.replaceChildren(title, separator, ...sources.map(source => {
      const item = document.createElement('article')
      item.dataset.status = source.tone
      const label = document.createElement('strong')
      const state = document.createElement('span')
      const date = document.createElement('time')
      label.textContent = source.label
      state.textContent = source.status
      date.textContent = source.date
      item.append(label, state, date)
      return item
    }))
    if (status.childNodes.length !== 1 || status.firstElementChild !== host) status.replaceChildren(host)
    status.classList.add('r7-source-header-active')
    status.setAttribute('aria-label', sources.map(source => `${source.label}${source.status}，数据日期${source.date}`).join('；'))
    document.body.classList.add('aph-home-source-header')
  }

  let queued = false
  function schedule() {
    if (queued) return
    queued = true
    window.requestAnimationFrame(() => {
      queued = false
      render()
    })
  }

  window.addEventListener('DOMContentLoaded', schedule, { once: true })
  window.addEventListener('popstate', schedule)
  window.addEventListener('cockpit:navigation', schedule)
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link && new URL(link.href, window.location.href).origin === window.location.origin) window.setTimeout(schedule, 0)
  }, true)
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
  if (document.readyState !== 'loading') schedule()
})()
