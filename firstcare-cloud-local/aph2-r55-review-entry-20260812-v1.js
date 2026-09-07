/* R55：研发审核入口只做一次硬跳转，避免驾驶舱 SPA 吞掉 SSO 启动页。 */
(() => {
  'use strict'

  const RELEASE = 'r55-review-entry-20260812-v1'
  if (window.__APH_R55_REVIEW_ENTRY__) return
  window.__APH_R55_REVIEW_ENTRY__ = RELEASE

  function normalizeReviewLinks(root = document) {
    root.querySelectorAll?.('a[href]').forEach(link => {
      const target = new URL(link.href, window.location.origin)
      const isReviewTarget = target.pathname === '/review' || target.pathname === '/review-system' || target.pathname === '/review-system/'
      if (target.origin !== window.location.origin || !isReviewTarget) return
      link.href = '/review'
      link.dataset.aphReviewEntry = RELEASE
    })
  }

  document.addEventListener('click', event => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link) return
    const target = new URL(link.href, window.location.origin)
    const isReviewTarget = target.pathname === '/review' || target.pathname === '/review-system' || target.pathname === '/review-system/'
    if (target.origin !== window.location.origin || !isReviewTarget) return
    event.preventDefault()
    event.stopImmediatePropagation()
    window.location.assign('/review')
  }, true)

  const start = () => {
    normalizeReviewLinks()
    const root = document.getElementById('root')
    if (root) {
      new MutationObserver(records => records.forEach(record => {
        record.addedNodes.forEach(node => {
          if (node instanceof Element) normalizeReviewLinks(node)
        })
      })).observe(root, { childList: true, subtree: true })
    }
  }

  document.documentElement.dataset.aphReviewEntry = RELEASE
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
