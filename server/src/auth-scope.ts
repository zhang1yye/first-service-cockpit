import { canAccessServiceCenterForUser, serviceCenterWhereForUser } from './service-center-access.js'

export type ScopeUser = {
  userId: number
  username: string
  role: 'admin' | 'hq_function' | 'region_manager' | 'area_manager' | 'project_manager' | 'viewer'
  areaScope?: string
  projectScope?: string
  serviceCenterScope?: string
}

function csvValues(value?: string): string[] {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean)
}

export function areaValues(user?: ScopeUser): string[] {
  return csvValues(user?.areaScope)
}

export function projectValues(user?: ScopeUser): number[] {
  return csvValues(user?.projectScope).map(Number).filter(Number.isFinite)
}

function scopedWhere(user: ScopeUser | undefined, fieldKind: 'project' | 'task', alias = ''): { clause: string; params: any[] } {
  return serviceCenterWhereForUser(user, fieldKind === 'project' ? 'name' : 'project_name', alias)
}

export function projectScopeForUser(user?: ScopeUser, alias = '') {
  return scopedWhere(user, 'project', alias)
}

export function taskScopeForUser(user?: ScopeUser, alias = '') {
  return scopedWhere(user, 'task', alias)
}

export function canAccessProjectForUser(user: ScopeUser | undefined, project: any): boolean {
  return canAccessServiceCenterForUser(user, project?.service_center ?? project?.name ?? project?.project_name)
}

export function canAccessAreaForUser(user: ScopeUser | undefined, area: string): boolean {
  if (user?.role === 'admin' || user?.role === 'hq_function') return true
  return user?.role === 'area_manager' && areaValues(user).length === 1 && areaValues(user)[0] === String(area || '').trim()
}
