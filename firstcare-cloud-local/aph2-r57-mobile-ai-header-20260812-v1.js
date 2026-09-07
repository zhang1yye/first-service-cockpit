/* R57：移动端 AI 入口进入顶栏账号左侧，保留原助手对话框与事件链路。 */
(() => {
  'use strict'

  const RELEASE = 'r57-mobile-ai-header-20260812-v1'
  const MOBILE = window.matchMedia('(max-width: 640px)')
  const APP_ROUTES = new Set([
    '/', '/command', '/projects', '/payment', '/daily', '/collection', '/arrears',
    '/ai-alerts', '/ai-report', '/import', '/review', '/system', '/admin', '/tasks',
  ])
  let proxy = null
  let scheduled = false

  const route = () => window.location.pathname.replace(/\/+$/, '') || '/'

  function assistantElements() {
    const root = document.getElementById('north-ai-assistant')
    return {
      root,
      launcher: root?.querySelector(':scope > .north-ai-launcher'),
      overlay: root?.querySelector(':scope > .north-ai-overlay'),
      input: root?.querySelector('.north-ai-input'),
    }
  }

  function mobileHeaderSlot() {
    const header = document.querySelector('header.sticky.top-0')
    const account = header?.querySelector('button[aria-label="账号菜单"]')
    const accountWrap = account?.parentElement
    const actions = accountWrap?.parentElement
    if (header && account && accountWrap && actions) {
      return { header, account, accountWrap, actions, placement: 'account' }
    }

    const adminHeader = route() === '/admin'
      ? document.querySelector('#root header.aph-admin-shell-header')
      : null
    return adminHeader
      ? { header: adminHeader, account: null, accountWrap: null, actions: adminHeader, placement: 'admin' }
      : null
  }

  function createProxy() {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'aph-r57-mobile-ai-launcher'
    button.setAttribute('aria-label', '打开华北经营助手')
    button.setAttribute('aria-haspopup', 'dialog')
    button.title = '华北经营助手'

    const mark = document.createElement('span')
    mark.className = 'aph-r57-mobile-ai-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.textContent = 'AI'
    button.append(mark)

    button.addEventListener('click', () => {
      const { launcher } = assistantElements()
      launcher?.click()
    })
    return button
  }

  function restoreProxyFocus() {
    window.setTimeout(() => {
      const { overlay } = assistantElements()
      if (MOBILE.matches && overlay?.getAttribute('aria-hidden') === 'true' && proxy?.isConnected) {
        proxy.focus()
      }
    }, 20)
  }

  function unmountMobileEntry() {
    proxy?.remove()
    proxy = null
    document.querySelectorAll('.aph-r57-mobile-ai-host').forEach(node => {
      node.classList.remove('aph-r57-mobile-ai-host')
    })
    delete document.body?.dataset.r57MobileAiHeader
    const { launcher } = assistantElements()
    launcher?.classList.remove('aph-r57-mobile-ai-source')
    launcher?.removeAttribute('aria-hidden')
    launcher?.removeAttribute('tabindex')
  }

  function apply() {
    scheduled = false
    if (!MOBILE.matches) return unmountMobileEntry()

    const { root, launcher } = assistantElements()
    const slot = mobileHeaderSlot()
    if (!root || !launcher || !slot) return

    document.body.dataset.r57MobileAiHeader = RELEASE
    root.dataset.r57MobileAiHeader = RELEASE
    launcher.classList.add('aph-r57-mobile-ai-source')
    launcher.setAttribute('aria-hidden', 'true')
    launcher.tabIndex = -1

    if (!proxy) proxy = createProxy()
    document.querySelectorAll('.aph-r57-mobile-ai-host').forEach(node => {
      node.classList.remove('aph-r57-mobile-ai-host')
    })
    slot.header.classList.toggle('aph-r57-mobile-ai-host', slot.placement === 'admin')
    proxy.dataset.r57Placement = slot.placement
    const current = route()
    const visible = current !== '/login'
      && (APP_ROUTES.has(current) || current.startsWith('/projects/'))
    proxy.hidden = !visible
    proxy.toggleAttribute('hidden', !visible)
    proxy.title = current === '/ai-alerts' || current === '/ai-report'
      ? '项目类 AI 受真实性门禁限制；可查询已发布经营数据'
      : '查询已发布的经营数据、口径与异常'

    if (slot.accountWrap && (
      proxy.parentElement !== slot.actions || proxy.nextElementSibling !== slot.accountWrap
    )) {
      slot.actions.insertBefore(proxy, slot.accountWrap)
    } else if (!slot.accountWrap && (
      proxy.parentElement !== slot.actions || proxy.nextElementSibling !== null
    )) {
      slot.actions.append(proxy)
    }
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(apply)
  }

  document.addEventListener('click', event => {
    const close = event.target instanceof Element
      ? event.target.closest('.north-ai-close')
      : null
    const overlay = event.target instanceof Element
      ? event.target.closest('.north-ai-overlay')
      : null
    if (close || (overlay && event.target === overlay)) restoreProxyFocus()
  }, true)
  document.addEventListener('keydown', event => {
    const { overlay } = assistantElements()
    if (event.key === 'Escape' && overlay?.getAttribute('aria-hidden') === 'false') {
      restoreProxyFocus()
    }
  }, true)

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
  MOBILE.addEventListener('change', schedule)
  window.addEventListener('popstate', schedule)
  window.addEventListener('cockpit:navigation', schedule)
  document.addEventListener('DOMContentLoaded', schedule, { once: true })
  schedule()
})()
