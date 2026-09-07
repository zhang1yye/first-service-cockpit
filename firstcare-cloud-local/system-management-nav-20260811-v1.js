/* 将驾驶舱“系统管理”统一收口到使用端与后台端的分流页。 */
(() => {
  const SYSTEM_HUB = '/system/'

  function refreshSystemLinks(root = document) {
    root.querySelectorAll('a[href="/admin"]').forEach((link) => {
      const text = (link.textContent || '').trim()
      const label = link.getAttribute('aria-label') || link.getAttribute('title') || ''
      if (!text.includes('数据管理') && !text.includes('系统管理') && !label.includes('系统管理')) return
      link.href = SYSTEM_HUB
      link.removeAttribute('aria-current')
      if (text.includes('数据管理')) {
        const leaf = [...link.querySelectorAll('span')].find((node) => node.textContent.trim() === '数据管理')
        if (leaf) leaf.textContent = '系统管理'
      }
    })
  }

  const observe = () => {
    const root = document.querySelector('#root')
    if (root) new MutationObserver(() => refreshSystemLinks(root)).observe(root, { childList: true, subtree: true })

    // React 首次渲染及登录态恢复可能晚于当前脚本，短时重试确保菜单已实际挂载后再替换入口。
    let remaining = 16
    const apply = () => {
      refreshSystemLinks(document)
      remaining -= 1
      if (remaining > 0) window.setTimeout(apply, 180)
    }
    apply()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true })
  else observe()
})()
