/* R65：普通成员范围提示与筛选收口。真正的数据隔离仍由后端逐接口强制。 */
(function () {
  'use strict'

  const USER_KEY = 'cockpit_user'
  const TOKEN_KEYS = ['cockpit_token', 'authToken', 'token']
  let currentUser

  function readStoredUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null')
    } catch {
      return null
    }
  }

  function token() {
    return TOKEN_KEYS.map(key => localStorage.getItem(key)).find(Boolean) || ''
  }

  function normalizeUser(user) {
    if (!user || typeof user !== 'object') return user
    const scope = user.service_center_scope || user.serviceCenterScope || ''
    const originalRole = user.role
    const normalizedRole = originalRole === 'admin' ? 'admin' : originalRole ? 'viewer' : originalRole
    return {
      ...user,
      role: normalizedRole,
      ...(originalRole && originalRole !== normalizedRole ? { legacyRole: originalRole } : {}),
      service_center_scope: scope,
      serviceCenterScope: scope
    }
  }

  currentUser = normalizeUser(readStoredUser())
  if (currentUser?.role) localStorage.setItem(USER_KEY, JSON.stringify(currentUser))

  function isMember() {
    return Boolean(currentUser && currentUser.role !== 'admin')
  }

  function scope() {
    return currentUser?.service_center_scope || currentUser?.serviceCenterScope || ''
  }

  async function refreshUser() {
    const bearer = token()
    if (!bearer) return currentUser
    try {
      const response = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${bearer}` },
        credentials: 'same-origin'
      })
      if (!response.ok) return currentUser
      const payload = await response.json()
      const user = normalizeUser(payload?.user || payload)
      if (user?.role) {
        currentUser = user
        localStorage.setItem(USER_KEY, JSON.stringify(user))
      }
    } catch {
      // 网络失败时保留已登录会话；后续业务请求仍由后端鉴权。
    }
    return currentUser
  }

  function ensureBadge() {
    const existing = document.getElementById('aph-r65-service-center-scope')
    if (!isMember()) {
      existing?.remove()
      return
    }
    const host = document.querySelector('.aph-header-status')
      || document.querySelector('header.sticky')
      || document.querySelector('#root > header')
    if (!host) return
    const badge = existing || document.createElement('span')
    badge.id = 'aph-r65-service-center-scope'
    badge.setAttribute('role', 'status')
    const nextText = `当前服务中心：${scope() || '未配置'}`
    const nextTitle = scope()
      ? `当前账号只可查看 ${scope()} 数据`
      : '当前账号尚未配置服务中心，请联系管理员'
    if (badge.textContent !== nextText) badge.textContent = nextText
    if (badge.title !== nextTitle) badge.title = nextTitle
    if (!existing) host.appendChild(badge)
  }

  function isScopeControl(control) {
    if (!(control instanceof HTMLSelectElement)) return false
    if (control.closest('.r65-admin')) return false
    const label = control.getAttribute('aria-label') || ''
    const id = control.id || ''
    const wrapperText = control.closest('label')?.textContent || ''
    return control.closest('[data-area-filter="true"]')
      || /片区|服务中心/.test(label)
      || /area-filter|center-filter/i.test(id)
      || /片区|服务中心/.test(wrapperText)
  }

  function lockScopeControls() {
    if (!isMember()) return
    document.querySelectorAll('select').forEach(control => {
      if (!isScopeControl(control)) return
      control.disabled = true
      const wrapper = control.closest('label') || control
      wrapper.setAttribute('data-r65-scope-control-hidden', 'true')
    })

    document.querySelectorAll('.r56-search, label[for="r56-center-search"], label[for="r56-area-filter"]').forEach(control => {
      control.setAttribute('data-r65-scope-control-hidden', 'true')
    })
  }

  function normalizeMemberProjectCopy() {
    if (!isMember() || !window.location.pathname.startsWith('/projects/')) return
    document.querySelectorAll('main div, main td').forEach(element => {
      if (element.children.length) return
      const original = (element.textContent || '').trim()
      const replacement = original.replace(/(片区|华北|同业态)(收费排名|均值|平均)/g, '本服务中心口径')
      if (replacement !== original && element.textContent !== replacement) element.textContent = replacement
    })
  }

  function applyScopeUi() {
    ensureBadge()
    lockScopeControls()
    normalizeMemberProjectCopy()
    document.documentElement.toggleAttribute('data-r65-service-center-member', isMember())
    if (isMember()) document.documentElement.dataset.r65ServiceCenterScope = scope() || 'unconfigured'
    else delete document.documentElement.dataset.r65ServiceCenterScope
  }

  function scheduleApply() {
    window.requestAnimationFrame(applyScopeUi)
  }

  window.__aphR65ScopeReady = refreshUser().finally(scheduleApply)

  const observer = new MutationObserver(scheduleApply)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('popstate', scheduleApply)
  window.addEventListener('aph:navigation', scheduleApply)
  window.addEventListener('storage', event => {
    if (event.key !== USER_KEY) return
    currentUser = normalizeUser(readStoredUser())
    scheduleApply()
  })
})()
