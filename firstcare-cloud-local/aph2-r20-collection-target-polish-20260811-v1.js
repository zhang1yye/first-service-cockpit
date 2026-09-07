(() => {
  'use strict'

  const RELEASE = 'r20-collection-target-polish-20260811-v1'
  const TARGET_RATE = 88.39
  let scheduled = false

  const parseRate = value => {
    const matched = String(value || '').match(/-?\d+(?:\.\d+)?/)
    return matched ? Number(matched[0]) : Number.NaN
  }

  function enhanceCollectionCard() {
    if (window.location.pathname !== '/') return

    const card = document.querySelector('.r8-home-collection')
    const link = card?.querySelector(':scope > .card-soft')
    const header = link?.firstElementChild
    const ring = card?.querySelector('.r8-home-rate-ring')
    const currentValue = ring?.querySelector('.num.text-2xl')
    const gapLabel = ring?.querySelector('.text-micro')
    if (!card || !link || !header || !ring || !currentValue || !gapLabel) return

    let target = header.querySelector('.r20-collection-target')
    if (!target) {
      target = document.createElement('span')
      target.className = 'r20-collection-target'
      target.innerHTML = '<span class="r20-collection-target-label">当期考核目标</span><strong>88.39%</strong>'
      const arrow = header.querySelector(':scope > svg:last-child')
      header.insertBefore(target, arrow || null)
    }

    const currentRate = parseRate(currentValue.textContent)
    const gap = Number.isFinite(currentRate) ? Math.max(TARGET_RATE - currentRate, 0) : Number.NaN
    gapLabel.textContent = Number.isFinite(gap) ? `距目标 ${gap.toFixed(2)}%` : '距目标 —'
    gapLabel.dataset.r20TargetRate = `${TARGET_RATE.toFixed(2)}%`
    gapLabel.title = `华北地区当期收缴率考核目标${TARGET_RATE.toFixed(2)}%`

    ring.setAttribute(
      'aria-label',
      Number.isFinite(currentRate)
        ? `当前收缴率${currentRate.toFixed(2)}%，当期考核目标${TARGET_RATE.toFixed(2)}%，距目标${gap.toFixed(2)}个百分点`
        : `当期收缴率考核目标${TARGET_RATE.toFixed(2)}%`,
    )
    card.dataset.r20CollectionVisual = RELEASE
    link.dataset.aphCollectionCurrentTarget = `${TARGET_RATE.toFixed(2)}%`
    document.body?.setAttribute('data-r20-collection-visual', RELEASE)
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(() => {
      scheduled = false
      enhanceCollectionCard()
    })
  }

  function start() {
    schedule()
    new MutationObserver(schedule).observe(
      document.getElementById('root') || document.documentElement,
      { childList: true, subtree: true },
    )
  }

  window.addEventListener('DOMContentLoaded', start, { once: true })
  window.addEventListener('popstate', schedule)
  window.addEventListener('cockpit:navigation', schedule)
  if (document.readyState !== 'loading') start()
})()
