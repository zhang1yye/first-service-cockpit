export const HEADQUARTERS_FUNCTION_ROLE = 'hq_function' as const
export const HEADQUARTERS_FUNCTION_SCOPE = '华北地区公司本部职能' as const
export const AREA_MANAGER_ROLE = 'area_manager' as const
export const PROJECT_MANAGER_ROLE = 'project_manager' as const
export const FRONTLINE_ROLE = 'viewer' as const

export const USER_ROLES = ['admin', HEADQUARTERS_FUNCTION_ROLE, 'region_manager', 'area_manager', 'project_manager', 'viewer'] as const
export type UserRole = typeof USER_ROLES[number]

export function hasRegionWideReadAccess(role: unknown): boolean {
  return role === 'admin' || role === HEADQUARTERS_FUNCTION_ROLE
}

// region_manager 仅保留旧令牌兼容，不再出现在成员管理的可分配类型中。
export const MEMBER_ROLES = [HEADQUARTERS_FUNCTION_ROLE, AREA_MANAGER_ROLE, PROJECT_MANAGER_ROLE, FRONTLINE_ROLE] as const

export function validateServiceCenterAssignment(role: string, serviceCenterScope: string): { ok: boolean; error?: string } {
  if (!USER_ROLES.includes(role as UserRole)) return { ok: false, error: '用户角色无效' }
  if (role === 'admin') return { ok: true }
  const centers = [...new Set(String(serviceCenterScope || '').split(',').map(value => value.trim()).filter(Boolean))]
  if (role === HEADQUARTERS_FUNCTION_ROLE) {
    return centers.length === 0 || (centers.length === 1 && centers[0] === HEADQUARTERS_FUNCTION_SCOPE)
      ? { ok: true }
      : { ok: false, error: '华北地区公司本部职能使用固定的华北全域只读范围' }
  }
  if (role === AREA_MANAGER_ROLE) {
    return centers.length === 0
      ? { ok: true }
      : { ok: false, error: '片区经理只绑定片区，不能再绑定服务中心' }
  }
  if (role === PROJECT_MANAGER_ROLE) {
    return centers.length > 0
      ? { ok: true }
      : { ok: false, error: '项目经理必须至少绑定一个服务中心' }
  }
  if (centers.length === 0) return { ok: false, error: '非管理员账号必须绑定一个服务中心' }
  if (centers.length > 1) return { ok: false, error: '一线职员只能绑定一个服务中心' }
  return { ok: true }
}

export function validateUserAccess(role: string, areaScope: string, projectScope: string): { ok: boolean; error?: string } {
  if (!USER_ROLES.includes(role as UserRole)) return { ok: false, error: '用户角色无效' }
  return { ok: true }
}
