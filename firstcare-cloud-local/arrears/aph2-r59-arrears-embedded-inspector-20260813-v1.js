/* R59：修复欠费 Inspector 在驾驶舱移动导航下的嵌入遮挡与跨 iframe 模态边界。 */
(() => {
  'use strict'

  const release = 'r59-arrears-embedded-inspector-20260813-v1'
  if (document.documentElement.dataset.r59ArrearsInspector === release) return
  document.documentElement.dataset.r59ArrearsInspector = release

  const inspector = document.getElementById('r55Inspector')
  if (!inspector) return

  let outerInerted = []
  let syncFrame = 0

  function restoreOuterInert() {
    outerInerted.forEach((node) => { node.inert = false })
    outerInerted = []
  }

  function isolateOuterShell(frame) {
    restoreOuterInert()
    let current = frame
    while (current?.parentElement) {
      const parent = current.parentElement
      ;[...parent.children].forEach((sibling) => {
        if (sibling === current || sibling.inert || ['SCRIPT', 'STYLE'].includes(sibling.tagName)) return
        sibling.inert = true
        outerInerted.push(sibling)
      })
      current = parent
      if (current === window.parent.document.body) break
    }
  }

  function syncEmbeddedModalBoundary() {
    const mobileOpen = !inspector.hidden && window.matchMedia('(max-width: 860px)').matches
    let inset = 0
    if (mobileOpen && window.top !== window.self) {
      try {
        const frame = window.frameElement
        const outerDocument = window.parent.document
        const navigation = outerDocument.querySelector('.aph-mobile-primary-nav')
        if (frame && navigation && window.parent.getComputedStyle(navigation).display !== 'none') {
          const frameRect = frame.getBoundingClientRect()
          const navigationRect = navigation.getBoundingClientRect()
          inset = Math.max(0, Math.ceil(navigationRect.bottom - frameRect.top))
        }
        if (frame) isolateOuterShell(frame)
      } catch {
        restoreOuterInert()
      }
    } else {
      restoreOuterInert()
    }
    document.documentElement.style.setProperty('--r59-arrears-inspector-top-inset', `${inset}px`)
    if (mobileOpen) inspector.style.setProperty('top', `${inset}px`, 'important')
    else inspector.style.removeProperty('top')
  }

  function scheduleSync() {
    if (syncFrame) return
    syncFrame = window.requestAnimationFrame(() => {
      syncFrame = 0
      syncEmbeddedModalBoundary()
    })
  }

  const observer = new MutationObserver(scheduleSync)
  observer.observe(inspector, { attributes: true, attributeFilter: ['hidden', 'role', 'aria-modal'] })
  window.addEventListener('resize', scheduleSync, { passive: true })
  window.visualViewport?.addEventListener('resize', scheduleSync, { passive: true })
  if (window.top !== window.self) {
    try {
      window.parent.addEventListener('scroll', scheduleSync, { passive: true })
      window.parent.addEventListener('resize', scheduleSync, { passive: true })
      window.parent.visualViewport?.addEventListener('scroll', scheduleSync, { passive: true })
      window.parent.visualViewport?.addEventListener('resize', scheduleSync, { passive: true })
    } catch {}
  }
  window.addEventListener('pagehide', restoreOuterInert, { once: true })
  syncEmbeddedModalBoundary()
  window.requestAnimationFrame(scheduleSync)
})()
