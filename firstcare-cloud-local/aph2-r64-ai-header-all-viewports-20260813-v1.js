/* R64：AI 入口统一进入顶栏，并修复移动壳层错位与抽屉残留。 */
(() => {
  'use strict'

  const RELEASE = 'r64-ai-header-all-viewports-20260813-v1'
  const DESKTOP = window.matchMedia('(min-width: 641px)')
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
    }
  }

  function headerSlot() {
    const adminHeader = route() === '/admin'
      ? document.querySelector('#root header.aph-admin-shell-header')
      : null
    if (adminHeader) {
      const adminAccountWrap = adminHeader.querySelector(':scope > .aph-r64-admin-account-wrap')
      return {
        header: adminHeader,
        accountWrap: adminAccountWrap,
        actions: adminHeader,
        placement: 'admin',
      }
    }

    const header = document.querySelector('header.sticky.top-0')
    const account = header?.querySelector('button[aria-label="账号菜单"]')
    const accountWrap = account?.parentElement
    const actions = accountWrap?.parentElement
    if (header && account && accountWrap && actions) {
      return { header, accountWrap, actions, placement: 'account' }
    }

    const fallbackActions = header?.querySelector(':scope > div > .ml-auto')
    if (header && fallbackActions) {
      return { header, accountWrap: null, actions: fallbackActions, placement: 'actions' }
    }

    return null
  }

  function closeMobileDrawer() {
    const drawer = document.querySelector('.aph-mobile-more-drawer:not([hidden])')
    if (!drawer) return
    const close = drawer.querySelector('button[aria-label="关闭更多功能"]')
    if (close instanceof HTMLButtonElement) {
      close.click()
      return
    }
    drawer.hidden = true
    document.body.classList.remove('aph-mobile-drawer-open')
    document.querySelector('.aph-mobile-more-trigger')?.setAttribute('aria-expanded', 'false')
  }

  function createProxy() {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'aph-r64-ai-launcher'
    button.setAttribute('aria-label', '打开华北经营助手')
    button.setAttribute('aria-haspopup', 'dialog')
    button.title = '查询已发布的经营数据、口径与异常'

    const mark = document.createElement('span')
    mark.className = 'aph-r64-desktop-ai-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.textContent = 'AI'
    button.append(mark)

    button.addEventListener('click', () => {
      closeMobileDrawer()
      assistantElements().launcher?.click()
    })
    return button
  }

  function activeEntry() {
    return proxy?.isConnected && getComputedStyle(proxy).display !== 'none' ? proxy : null
  }

  function restoreEntryFocus() {
    window.setTimeout(() => {
      const { overlay } = assistantElements()
      if (overlay?.getAttribute('aria-hidden') === 'true') activeEntry()?.focus()
    }, 40)
  }

  function removeMobileAdminIdentity() {
    document.querySelectorAll('.aph-r64-admin-mobile-identity').forEach(node => node.remove())
    document.querySelectorAll('.aph-r64-admin-account-wrap').forEach(node => node.remove())
  }

  function closeAdminAccountMenu({ restoreFocus = false } = {}) {
    document.querySelectorAll('.aph-r64-admin-account-wrap').forEach(wrap => {
      const button = wrap.querySelector('.aph-r64-admin-account')
      const menu = wrap.querySelector('.aph-r64-admin-account-menu')
      if (!(button instanceof HTMLButtonElement) || !(menu instanceof HTMLElement)) return
      const wasOpen = !menu.hidden
      menu.hidden = true
      button.setAttribute('aria-expanded', 'false')
      if (restoreFocus && wasOpen) button.focus({ preventScroll: true })
    })
  }

  function ensureMobileAdminIdentity(header) {
    let identity = header.querySelector(':scope > .aph-r64-admin-mobile-identity')
    const existingAccount = header.querySelector(':scope > .aph-r64-admin-account-wrap')
    if (identity && existingAccount) return identity
    identity?.remove()
    existingAccount?.remove()

    identity = document.createElement('div')
    identity.className = 'aph-r64-admin-mobile-identity'

    const brand = document.createElement('a')
    brand.className = 'aph-r64-admin-mobile-brand'
    brand.href = '/'
    brand.setAttribute('aria-label', '返回驾驶舱')
    brand.title = '返回驾驶舱'

    const logo = document.createElement('img')
    logo.src = '/logo.png'
    logo.alt = ''
    logo.setAttribute('aria-hidden', 'true')

    const title = document.createElement('strong')
    title.className = 'aph-r64-admin-mobile-title'
    title.textContent = '数据管理'
    identity.append(brand, title)
    brand.append(logo)

    const accountWrap = document.createElement('div')
    accountWrap.className = 'aph-r64-admin-account-wrap'

    const account = document.createElement('button')
    account.type = 'button'
    account.className = 'aph-r64-admin-account'
    account.setAttribute('aria-label', '账号菜单')
    account.setAttribute('aria-haspopup', 'menu')
    account.setAttribute('aria-expanded', 'false')
    account.setAttribute('aria-controls', 'aph-r64-admin-account-menu')
    account.title = '账号与会话'
    account.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="8" r="3"></circle><path d="M5 20c.6-4 3-6 7-6s6.4 2 7 6"></path></svg>'

    const menu = document.createElement('div')
    menu.id = 'aph-r64-admin-account-menu'
    menu.className = 'aph-r64-admin-account-menu'
    menu.setAttribute('role', 'menu')
    menu.hidden = true

    const session = document.createElement('strong')
    session.textContent = '后台管理会话'
    const home = document.createElement('a')
    home.href = '/'
    home.setAttribute('role', 'menuitem')
    home.textContent = '返回驾驶舱'
    menu.append(session, home)
    accountWrap.append(account, menu)

    account.addEventListener('click', () => {
      const willOpen = menu.hidden
      closeAdminAccountMenu()
      menu.hidden = !willOpen
      account.setAttribute('aria-expanded', String(willOpen))
      if (willOpen) home.focus({ preventScroll: true })
    })
    home.addEventListener('click', () => closeAdminAccountMenu())

    const r57Entry = header.querySelector(':scope > .aph-r57-mobile-ai-launcher')
    header.insertBefore(identity, r57Entry || null)
    header.insertBefore(accountWrap, r57Entry || null)
    return identity
  }

  function unmountEntry() {
    proxy?.remove()
    document.querySelectorAll('.aph-r64-ai-host').forEach(node => {
      node.classList.remove('aph-r64-ai-host')
    })
    removeMobileAdminIdentity()
  }

  function apply() {
    scheduled = false
    const { root, launcher } = assistantElements()
    if (!document.body || !root || !launcher) return

    document.body.dataset.r64AiHeader = RELEASE
    root.dataset.r64AiHeader = RELEASE
    launcher.classList.add('aph-r64-ai-source')

    const current = route()
    const visible = current !== '/login'
      && (APP_ROUTES.has(current) || current.startsWith('/projects/'))
    const mobileShell = !DESKTOP.matches && visible
    document.body.classList.toggle('aph-r64-mobile-shell', mobileShell)

    const mobileAdminHeader = mobileShell && current === '/admin'
      ? document.querySelector('#root header.aph-admin-shell-header')
      : null
    if (mobileAdminHeader) ensureMobileAdminIdentity(mobileAdminHeader)
    else removeMobileAdminIdentity()

    const slot = headerSlot()
    if (!slot) return unmountEntry()
    if (!proxy) proxy = createProxy()

    document.querySelectorAll('.aph-r64-ai-host').forEach(node => {
      node.classList.remove('aph-r64-ai-host')
    })
    slot.header.classList.toggle('aph-r64-ai-host', slot.placement === 'admin')
    proxy.dataset.r64Placement = slot.placement

    proxy.hidden = !visible
    proxy.toggleAttribute('hidden', !visible)
    proxy.title = current === '/ai-alerts' || current === '/ai-report'
      ? '项目类 AI 受真实性门禁限制；可查询已发布经营数据'
      : '查询已发布的经营数据、口径与异常'

    const r57Anchor = !DESKTOP.matches && slot.placement !== 'admin'
      ? slot.actions.querySelector(':scope > .aph-r57-mobile-ai-launcher')
      : null
    if (r57Anchor && (
      proxy.parentElement !== slot.actions || proxy.nextElementSibling !== r57Anchor
    )) {
      slot.actions.insertBefore(proxy, r57Anchor)
    } else if (!r57Anchor && slot.accountWrap && (
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
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.aph-mobile-primary-nav a,.aph-r57-mobile-ai-launcher,.aph-r64-ai-launcher')) {
      closeMobileDrawer()
    }
    const close = target?.closest('.north-ai-close')
    const overlay = target?.closest('.north-ai-overlay')
    if (close || (overlay && target === overlay)) restoreEntryFocus()
    if (!target?.closest('.aph-r64-admin-account-wrap')) closeAdminAccountMenu()
  }, true)

  document.addEventListener('keydown', event => {
    const { overlay } = assistantElements()
    if (event.key === 'Escape' && overlay?.getAttribute('aria-hidden') === 'false') {
      restoreEntryFocus()
    } else if (event.key === 'Escape') {
      closeAdminAccountMenu({ restoreFocus: true })
    }
  }, true)

  const observer = new MutationObserver(schedule)
  function observeDocument() {
    if (!document.documentElement) return
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
    schedule()
  }

  if (document.documentElement) observeDocument()
  else document.addEventListener('readystatechange', observeDocument, { once: true })
  function handleNavigation() {
    closeMobileDrawer()
    schedule()
  }

  DESKTOP.addEventListener('change', schedule)
  window.addEventListener('popstate', handleNavigation)
  window.addEventListener('cockpit:navigation', handleNavigation)
  document.addEventListener('DOMContentLoaded', schedule, { once: true })
  schedule()
})()
