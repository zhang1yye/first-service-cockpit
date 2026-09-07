export const rolePermissions = {
  管理员: ['submitProposal', 'reviewProposal', 'manageSystem', 'manageUsers', 'viewLogs'],
  使用者: ['submitProposal'],
  审核员: ['reviewProposal', 'viewLogs'],
  提交人: ['submitProposal'],
  观察员: ['viewLogs']
}

export const permissionLabels = {
  submitProposal: '方案提交',
  reviewProposal: '审核流转',
  manageSystem: '系统配置',
  manageUsers: '人员管理',
  viewLogs: '日志与数据'
}

export const permissionRoutes = [
  { label: '工作台', path: '/' },
  { label: '方案提交', path: '/submit', permission: 'submitProposal' },
  { label: '审核中心', path: '/review', permission: 'reviewProposal' },
  { label: '审核机器人', path: '/bots', permission: 'manageSystem' },
  { label: '人员管理', path: '/users', permission: 'manageUsers' },
  { label: '专业知识库', path: '/knowledge', permission: 'manageSystem' },
  { label: '规则配置', path: '/rules', permission: 'manageSystem' },
  { label: '数据分析', path: '/stats', permission: 'viewLogs' },
  { label: '日志中心', path: '/logs', permission: 'viewLogs' },
  { label: '系统设置', path: '/settings', permission: 'manageSystem' }
]

function normalizeUserRole(role = '') {
  const value = String(role || '').trim()
  return Object.prototype.hasOwnProperty.call(rolePermissions, value) ? value : ''
}

export function permissionsForRole(role = '') {
  return rolePermissions[normalizeUserRole(role)] || []
}

export function permissionsForUser(user) {
  if (!user) return []
  const rolePermissionSet = new Set(permissionsForRole(user.role))
  if (!Array.isArray(user.permissions)) return [...rolePermissionSet]
  return [...new Set(user.permissions.filter(permission => rolePermissionSet.has(permission)))]
}

export function hasPermission(user, permission) {
  if (!permission) return true
  return permissionsForUser(user).includes(permission)
}

export function shouldForcePasswordChange(user) {
  return Boolean(user?.mustChangePassword) && normalizeUserRole(user?.role) !== '管理员'
}

export function readablePermissions(user) {
  return permissionsForUser(user).map(permission => permissionLabels[permission] || permission)
}

export function accessibleRoutes(user) {
  return permissionRoutes.filter(route => hasPermission(user, route.permission))
}

export function redirectPathForUser(user, target = '/') {
  try {
    const url = new URL(String(target || '/'), window.location.origin)
    return canAccessPath(user, url.pathname) ? `${url.pathname}${url.search}${url.hash}` : '/'
  } catch {
    return '/'
  }
}

export function canAccessPath(user, pathname = '/') {
  const path = pathname || '/'
  if (path.startsWith('/users')) return hasPermission(user, 'manageUsers')
  if (path.startsWith('/bots')) return hasPermission(user, 'manageSystem')
  if (path.startsWith('/knowledge')) return hasPermission(user, 'manageSystem')
  if (path.startsWith('/rules')) return hasPermission(user, 'manageSystem')
  if (path.startsWith('/settings')) return hasPermission(user, 'manageSystem')
  if (path.startsWith('/review')) return hasPermission(user, 'reviewProposal')
  if (path.startsWith('/stats')) return hasPermission(user, 'viewLogs')
  if (path.startsWith('/logs')) return hasPermission(user, 'viewLogs')
  if (path.startsWith('/submit')) return hasPermission(user, 'submitProposal')
  return true
}
