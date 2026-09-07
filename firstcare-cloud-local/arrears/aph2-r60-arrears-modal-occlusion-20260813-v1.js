/* R60：欠费移动 Inspector 打开时隐藏外层固定遮挡物，关闭后精确恢复。 */
(() => {
  'use strict'

  const release = 'r60-arrears-modal-occlusion-20260813-v1'
  if (document.documentElement.dataset.r60ArrearsModal === release) return
  document.documentElement.dataset.r60ArrearsModal = release

  const inspector = document.getElementById('r55Inspector')
  if (!inspector) return

  const selectors = [
    '.aph-mobile-primary-nav',
    '.aph-mobile-more-drawer',
    '#north-ai-assistant',
    '.aph-r57-mobile-ai-launcher',
  ].join(',')
  let hiddenOuterNodes = []
  let syncFrame = 0

  function restoreOuterOccluders() {
    hiddenOuterNodes.forEach(({ node, value, priority }) => {
      if (!node.isConnected) return
      if (value) node.style.setProperty('display', value, priority)
      else node.style.removeProperty('display')
    })
    hiddenOuterNodes = []
  }

  function hideOuterOccluders() {
    if (hiddenOuterNodes.length || window.top === window.self) return
    try {
      hiddenOuterNodes = [...window.parent.document.querySelectorAll(selectors)].map((node) => {
        const value = node.style.getPropertyValue('display')
        const priority = node.style.getPropertyPriority('display')
        node.style.setProperty('display', 'none', 'important')
        return { node, value, priority }
      })
    } catch {
      restoreOuterOccluders()
    }
  }

  function syncModalOcclusion() {
    const mobileOpen = !inspector.hidden && window.matchMedia('(max-width: 860px)').matches
    if (mobileOpen && window.top !== window.self) {
      hideOuterOccluders()
      document.documentElement.style.setProperty('--r59-arrears-inspector-top-inset', '0px')
      inspector.style.setProperty('top', '0px', 'important')
    } else {
      restoreOuterOccluders()
      if (inspector.hidden || !window.matchMedia('(max-width: 860px)').matches) inspector.style.removeProperty('top')
    }
  }

  function scheduleSync() {
    if (syncFrame) return
    syncFrame = window.requestAnimationFrame(() => {
      syncFrame = 0
      syncModalOcclusion()
    })
  }

  new MutationObserver(scheduleSync).observe(inspector, {
    attributes: true,
    attributeFilter: ['hidden', 'role', 'aria-modal'],
  })
  window.addEventListener('resize', scheduleSync, { passive: true })
  window.visualViewport?.addEventListener('resize', scheduleSync, { passive: true })
  if (window.top !== window.self) {
    try {
      window.parent.addEventListener('scroll', scheduleSync, { passive: true })
      window.parent.addEventListener('resize', scheduleSync, { passive: true })
    } catch {}
  }
  window.addEventListener('pagehide', restoreOuterOccluders, { once: true })
  syncModalOcclusion()
  window.requestAnimationFrame(scheduleSync)
})()
