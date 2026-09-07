const API_BASE = window.location.pathname.startsWith('/review-system') ? '/review-api' : '/api'
const AUTH_USER_UPDATED_EVENT = 'auth:user-updated'
const AUTH_PERMISSION_DENIED_EVENT = 'auth:permission-denied'
const LOGIN_REDIRECT_KEY = 'loginRedirect'

export function safeRedirectPath(value = '/') {
  const text = String(value || '/').trim()
  if (!text.startsWith('/') || text.startsWith('//')) return '/'
  if (text.startsWith('/login')) return '/'
  if (text.startsWith('/change-password')) return '/'
  return text
}

export function rememberLoginRedirect(path = '') {
  const target = safeRedirectPath(path || `${window.location.pathname}${window.location.search}${window.location.hash}`)
  if (target === '/') return
  sessionStorage.setItem(LOGIN_REDIRECT_KEY, target)
}

export function getLoginRedirect() {
  return safeRedirectPath(sessionStorage.getItem(LOGIN_REDIRECT_KEY) || '/')
}

export function consumeLoginRedirect() {
  const target = getLoginRedirect()
  sessionStorage.removeItem(LOGIN_REDIRECT_KEY)
  return target
}

export function clearLoginRedirect() {
  sessionStorage.removeItem(LOGIN_REDIRECT_KEY)
}

function sessionExpiryTime() {
  const value = localStorage.getItem('sessionExpiresAt')
  if (!value) return 0
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function getSessionRemainingMs() {
  const expiresAt = sessionExpiryTime()
  if (!expiresAt) return null
  return expiresAt - Date.now()
}

export function isSessionExpired() {
  const remaining = getSessionRemainingMs()
  return remaining !== null && remaining <= 0
}

function notifyAuthUserUpdated(user) {
  window.dispatchEvent(new CustomEvent(AUTH_USER_UPDATED_EVENT, { detail: user }))
}

function notifyPermissionDenied(message) {
  window.dispatchEvent(new CustomEvent(AUTH_PERMISSION_DENIED_EVENT, { detail: { message } }))
}

function shouldRedirectToPasswordChange(user = {}) {
  return user?.mustChangePassword === true && user?.role !== '管理员'
}

function syncUserFromHeaders(res) {
  const roleHeader = res.headers.get('X-User-Role')
  const permissionsHeader = res.headers.get('X-User-Permissions')
  const mustChangePasswordHeader = res.headers.get('X-User-Must-Change-Password')
  const sessionExpiresAtHeader = res.headers.get('X-Session-Expires-At')
  if (!roleHeader && permissionsHeader === null && mustChangePasswordHeader === null && !sessionExpiresAtHeader) return
  if (sessionExpiresAtHeader) localStorage.setItem('sessionExpiresAt', sessionExpiresAtHeader)

  const current = getUser() || {}
  const nextUser = {
    ...current,
    ...(roleHeader ? { role: decodeURIComponent(roleHeader) } : {}),
    ...(mustChangePasswordHeader !== null ? { mustChangePassword: mustChangePasswordHeader === 'true' } : {}),
    permissions: permissionsHeader !== null
      ? permissionsHeader.split(',').map(item => item.trim()).filter(Boolean)
      : current.permissions || []
  }

  const currentPermissions = Array.isArray(current.permissions) ? current.permissions : []
  const nextPermissions = Array.isArray(nextUser.permissions) ? nextUser.permissions : []
  const authStateChanged = current.role !== nextUser.role ||
    current.mustChangePassword !== nextUser.mustChangePassword ||
    currentPermissions.length !== nextPermissions.length ||
    currentPermissions.some((permission, index) => permission !== nextPermissions[index])
  if (!authStateChanged) return

  localStorage.setItem('user', JSON.stringify(nextUser))
  notifyAuthUserUpdated(nextUser)
}

async function request(path, options = {}) {
  const token = localStorage.getItem('token')
  const headers = { ...options.headers }
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers })
  syncUserFromHeaders(res)
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    const redirectTarget = safeRedirectPath(`${window.location.pathname}${window.location.search}${window.location.hash}`)
    logoutLocal()
    if (window.location.pathname !== '/login') {
      rememberLoginRedirect(redirectTarget)
      window.location.href = `/login?reason=session-expired&redirect=${encodeURIComponent(redirectTarget)}`
    }
    throw new Error(data.message || '登录已失效，请重新登录')
  }
  if (!res.ok) {
    const error = new Error(data.message || `请求失败 (${res.status})`)
    error.status = res.status
    error.data = data
    if (res.status === 403 && data.mustChangePassword) {
      const current = getUser() || {}
      const nextUser = { ...current, mustChangePassword: true }
      localStorage.setItem('user', JSON.stringify(nextUser))
      notifyAuthUserUpdated(nextUser)
      if (shouldRedirectToPasswordChange(nextUser)) {
        const redirectTarget = safeRedirectPath(`${window.location.pathname}${window.location.search}${window.location.hash}`)
        rememberLoginRedirect(redirectTarget)
        if (window.location.pathname !== '/change-password') {
          window.location.href = '/change-password'
        }
      } else {
        notifyPermissionDenied(error.message)
      }
    } else if (res.status === 403) {
      notifyPermissionDenied(error.message)
    }
    throw error
  }
  return data
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body) }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path, body) => request(path, { method: 'DELETE', ...(body ? { body: JSON.stringify(body) } : {}) })
}

export function fileUrl(path) {
  return `${API_BASE}${path}`
}

export function filenameFromContentDisposition(value = '') {
  const text = String(value || '')
  const utf8Match = text.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''))
    } catch {
      return utf8Match[1].trim().replace(/^"|"$/g, '')
    }
  }
  const match = text.match(/filename\s*=\s*("([^"]+)"|([^;]+))/i)
  return (match?.[2] || match?.[3] || '').trim()
}

export async function downloadFile(path, filename = '附件') {
  const token = localStorage.getItem('token')
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(fileUrl(path), { headers })
  if (res.status === 401) {
    const redirectTarget = safeRedirectPath(`${window.location.pathname}${window.location.search}${window.location.hash}`)
    logoutLocal()
    if (window.location.pathname !== '/login') {
      rememberLoginRedirect(redirectTarget)
      window.location.href = `/login?reason=session-expired&redirect=${encodeURIComponent(redirectTarget)}`
    }
    throw new Error('登录已失效，请重新登录')
  }
  if (!res.ok) {
    const contentType = res.headers.get('content-type') || ''
    const errorData = contentType.includes('application/json')
      ? await res.json().catch(() => ({}))
      : { message: await res.text().catch(() => '') }
    throw new Error(errorData.message || `下载失败 (${res.status})`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filenameFromContentDisposition(res.headers.get('content-disposition')) || filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function downloadWithOneTimeTicket(ticket = {}) {
  const downloadUrl = String(ticket.downloadUrl || '').trim()
  const filename = String(ticket.filename || '系统备份归档').trim()
  const url = new URL(downloadUrl, window.location.origin)
  const expectedPrefix = '/review-api/system-backup/download/'
  const ticketValue = url.pathname.startsWith(expectedPrefix) ? url.pathname.slice(expectedPrefix.length) : ''

  if (url.origin !== window.location.origin || url.search || url.hash || !/^[A-Za-z0-9_-]{43}$/.test(ticketValue)) {
    throw new Error('服务器返回的备份下载票据无效，已阻止跳转')
  }
  if (ticket.oneTime !== true || !ticket.expiresAt) {
    throw new Error('服务器未确认下载票据为单次限时票据')
  }

  const link = document.createElement('a')
  link.href = url.href
  link.download = filename
  link.referrerPolicy = 'no-referrer'
  link.rel = 'noreferrer'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export async function uploadFile(path, file, fieldName = 'file', extraFields = {}) {
  const form = new FormData()
  form.append(fieldName, file)
  Object.entries(extraFields).forEach(([key, value]) => form.append(key, value))
  return api.post(path, form)
}

// 认证

export async function cockpitSso(token) {
  const res = await api.post('/auth/cockpit-sso', { token })
  localStorage.setItem('token', res.token)
  if (res.expiresAt) localStorage.setItem('sessionExpiresAt', res.expiresAt)
  localStorage.setItem('user', JSON.stringify(res.user || { name: '驾驶舱管理员', role: '管理员' }))
  return res
}

export async function login(username, password) {
  const res = await api.post('/auth/login', { username, password })
  localStorage.setItem('token', res.token)
  if (res.expiresAt) localStorage.setItem('sessionExpiresAt', res.expiresAt)
  localStorage.setItem('user', JSON.stringify(res.user || { name: username, role: '管理员' }))
  return res
}

export async function changePassword(oldPassword, newPassword) {
  const res = await api.post('/auth/change-password', { oldPassword, newPassword })
  if (res.token) localStorage.setItem('token', res.token)
  if (res.expiresAt) localStorage.setItem('sessionExpiresAt', res.expiresAt)
  if (res.user) {
    localStorage.setItem('user', JSON.stringify(res.user))
    notifyAuthUserUpdated(res.user)
  }
  return res
}

export async function refreshSession() {
  const res = await api.get('/auth/session')
  if (res.expiresAt) localStorage.setItem('sessionExpiresAt', res.expiresAt)
  if (res.user) {
    localStorage.setItem('user', JSON.stringify(res.user))
    notifyAuthUserUpdated(res.user)
  }
  return res
}

export function logoutLocal() {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  localStorage.removeItem('sessionExpiresAt')
}

export async function logout() {
  const token = localStorage.getItem('token')
  logoutLocal()
  if (!token) return

  await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => {})
}

export function getUser() {
  try { return JSON.parse(localStorage.getItem('user')) } catch { return null }
}

export function isLoggedIn() {
  if (!localStorage.getItem('token')) return false
  if (isSessionExpired()) {
    const redirectTarget = safeRedirectPath(`${window.location.pathname}${window.location.search}${window.location.hash}`)
    logoutLocal()
    if (window.location.pathname !== '/login') rememberLoginRedirect(redirectTarget)
    return false
  }
  return true
}
