(() => {
  'use strict'

  const MAP_SELECTOR = 'svg[aria-label="辽宁、河北、天津、北京区域地图"]'
  const RELEASE = 'r50-home-map-label-20260812-v1'
  const OVERLAY_SELECTOR = ':scope > g[data-r50-map-label-overlay="beijing"]'
  let scheduledFrame = 0

  function directRegionName(group) {
    return Array.from(group?.children || []).find(element => (
      element.tagName?.toLowerCase() === 'text'
    ))?.textContent?.trim() || ''
  }

  function repairBeijingLabelLayer() {
    if (window.location.pathname !== '/') return
    const map = document.querySelector(MAP_SELECTOR)
    if (!map) return

    const beijingGroup = Array.from(map.querySelectorAll(':scope > g[tabindex="0"]'))
      .find(group => directRegionName(group) === '北京')
    if (!beijingGroup) return

    const labelNodes = Array.from(beijingGroup.children).filter(element => (
      ['line', 'text'].includes(element.tagName?.toLowerCase())
    ))
    if (!labelNodes.length) return

    const signature = labelNodes.map(element => element.outerHTML).join('')
    let overlay = map.querySelector(OVERLAY_SELECTOR)
    if (!overlay) {
      overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      overlay.dataset.r50MapLabelOverlay = 'beijing'
      overlay.setAttribute('aria-hidden', 'true')
      overlay.setAttribute('focusable', 'false')
      overlay.setAttribute('pointer-events', 'none')
    }

    if (overlay.dataset.r50SourceSignature !== signature) {
      overlay.replaceChildren(...labelNodes.map(element => element.cloneNode(true)))
      overlay.dataset.r50SourceSignature = signature
    }
    if (overlay !== map.lastElementChild) map.append(overlay)
    document.body?.setAttribute('data-r50-map-label-release', RELEASE)
  }

  function scheduleRepair() {
    if (scheduledFrame) return
    scheduledFrame = window.requestAnimationFrame(() => {
      scheduledFrame = 0
      repairBeijingLabelLayer()
    })
  }

  const observer = new MutationObserver(scheduleRepair)
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
  window.addEventListener('pageshow', scheduleRepair)
  window.addEventListener('popstate', scheduleRepair)

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRepair, { once: true })
  } else {
    scheduleRepair()
  }
})()
