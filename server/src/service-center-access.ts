import db from './db.js'
import type { ScopeUser } from './auth-scope.js'
import { AREA_MANAGER_ROLE, HEADQUARTERS_FUNCTION_ROLE, HEADQUARTERS_FUNCTION_SCOPE, PROJECT_MANAGER_ROLE } from './user-access.js'
import { normalizeCollectionCenter } from './collection-quality.js'
import { formalP46PublicationPredicate } from './formal-p46-publication.js'
import { effectiveServiceCenterState, latestEffectiveMasterChanges } from './service-center-master.js'

export type ServiceCenterOption = {
  center: string
  area: string
}

type CenterCandidate = ServiceCenterOption & {
  priority: number
}

function safeRows(sql: string): any[] {
  try { return db.prepare(sql).all() as any[] } catch { return [] }
}

/**
 * 汇总当前正式主数据中的服务中心，并通过已审计的跨源映射合并别名。
 * 该清单既是成员管理下拉框的数据源，也是后端授权校验的唯一白名单。
 */
function centerRegistry(): Array<ServiceCenterOption & { aliases: string[] }> {
  const candidates: CenterCandidate[] = []
  const links: Array<[string, string]> = []
  const authoritative = new Set<string>()
  const add = (center: unknown, area: unknown, priority: number) => {
    const name = String(center || '').trim()
    if (!normalizeCollectionCenter(name)) return
    candidates.push({ center: name, area: String(area || '').trim(), priority })
  }

  for (const row of safeRows('SELECT center,area FROM payment_centers ORDER BY id')) add(row.center, row.area, 20)
  for (const row of safeRows('SELECT center,area FROM collection_centers ORDER BY id')) add(row.center, row.area, 30)
  const masterChanges = latestEffectiveMasterChanges()
  const masterRows = safeRows(`SELECT service_center center,area,management_status FROM project_profiles
    WHERE batch_id=(SELECT id FROM project_profile_import_batches ORDER BY id DESC LIMIT 1)
    ORDER BY id`).map(row => ({ ...row, effective: effectiveServiceCenterState(row.center, row.area, row.management_status, masterChanges) }))
  for (const row of masterRows) add(row.center, row.effective.area, 10)
  for (const row of masterRows) authoritative.add(normalizeCollectionCenter(row.center))
  const authoritativeCounts = new Map<string, number>()
  for (const row of masterRows) {
    const key = normalizeCollectionCenter(row.center)
    if (key) authoritativeCounts.set(key, (authoritativeCounts.get(key) || 0) + 1)
  }
  const conflictingAuthorityKeys = new Set([...authoritativeCounts.entries()]
    .filter(([, count]) => count > 1).map(([key]) => key))
  for (const key of conflictingAuthorityKeys) authoritative.delete(key)

  // 旧经营项目表没有稳定外键：仅在“同片区且唯一包含匹配”时建立别名；歧义或未匹配均不授权。
  const authoritativeRows = candidates.filter(candidate => candidate.priority === 10)
    .filter(candidate => !conflictingAuthorityKeys.has(normalizeCollectionCenter(candidate.center)))
  for (const row of safeRows("SELECT name center,area FROM projects WHERE COALESCE(active_status,'active')='active' ORDER BY id")) {
    const sourceKey = normalizeCollectionCenter(row.center)
    const matches = authoritativeRows.filter(candidate => {
      if (candidate.area && row.area && candidate.area !== row.area) return false
      const canonicalKey = normalizeCollectionCenter(candidate.center)
      return sourceKey === canonicalKey || canonicalKey.includes(sourceKey) || sourceKey.includes(canonicalKey)
    })
    if (matches.length === 1) {
      add(row.center, row.area, 40)
      links.push([matches[0].center, String(row.center || '')])
    }
  }

  for (const row of safeRows(`SELECT p.service_center canonical,p.area,p.management_status,l.source_center source
    FROM project_profile_center_links l
    JOIN project_profiles p ON p.id=l.profile_id
    WHERE p.batch_id=(SELECT id FROM project_profile_import_batches ORDER BY id DESC LIMIT 1)`)) {
    const effective = effectiveServiceCenterState(row.canonical, row.area, row.management_status, masterChanges)
    add(row.canonical, effective.area, 10)
    add(row.source, effective.area, 50)
    links.push([String(row.canonical || ''), String(row.source || '')])
  }
  const formalPublication = formalP46PublicationPredicate('b')
  for (const row of safeRows(`WITH latest_formal_batch AS (
      SELECT b.id FROM data_ingestion_batches b
      WHERE b.status='published' AND length(b.batch_sha256)=64 AND COALESCE(b.published_at,'')<>''
        AND ${formalPublication}
      ORDER BY b.business_date DESC,b.id DESC LIMIT 1
    )
    SELECT r.source_key source,r.canonical_key canonical,
      COALESCE(json_extract(r.payload,'$.area'),'') area
    FROM data_ingestion_rows r
    JOIN latest_formal_batch latest ON latest.id=r.batch_id
    WHERE r.entity_type='collection_center'`)) {
    add(row.canonical, row.area, 15)
    add(row.source, row.area, 50)
    links.push([String(row.canonical || ''), String(row.source || '')])
  }

  const parent = new Map<string, string>()
  const find = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key)
    const current = parent.get(key)!
    if (current === key) return key
    const root = find(current)
    parent.set(key, root)
    return root
  }
  const union = (left: string, right: string) => {
    const a = normalizeCollectionCenter(left)
    const b = normalizeCollectionCenter(right)
    if (!a || !b) return
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }
  for (const candidate of candidates) find(normalizeCollectionCenter(candidate.center))

  // 同一个源别名可能被历史映射指向多个规范中心。此时不能把多个中心合并到
  // 同一权限组：按规范化后的源别名汇总目标，只有目标唯一且目标本身是当前
  // “在管”规范中心时才建立映射；冲突、过期或孤立映射全部失败关闭。
  const targetsByAlias = new Map<string, Set<string>>()
  for (const [canonical, source] of links) {
    const canonicalKey = normalizeCollectionCenter(canonical)
    const sourceKey = normalizeCollectionCenter(source)
    if (!canonicalKey || !sourceKey) continue
    const targets = targetsByAlias.get(sourceKey) || new Set<string>()
    targets.add(canonicalKey)
    // 若源别名本身也是一个在管规范中心，则它天然指向自身；任何指向其他中心
    // 的历史映射都应被视为歧义，不能据此扩大成员权限。
    if (authoritative.has(sourceKey)) targets.add(sourceKey)
    targetsByAlias.set(sourceKey, targets)
  }
  for (const [canonical, source] of links) {
    const canonicalKey = normalizeCollectionCenter(canonical)
    const sourceKey = normalizeCollectionCenter(source)
    const targets = targetsByAlias.get(sourceKey)
    if (!canonicalKey || !sourceKey || !targets || targets.size !== 1) continue
    if (!authoritative.has(canonicalKey) || !targets.has(canonicalKey)) continue
    union(canonical, source)
  }

  const grouped = new Map<string, CenterCandidate[]>()
  for (const candidate of candidates) {
    const root = find(normalizeCollectionCenter(candidate.center))
    const rows = grouped.get(root) || []
    rows.push(candidate)
    grouped.set(root, rows)
  }

  return [...grouped.entries()].filter(([root]) => {
    const authorityRoots = [...authoritative].map(find)
    return authorityRoots.includes(root)
  }).map(([, rows]) => {
    const ordered = [...rows].sort((a, b) => a.priority - b.priority || a.center.localeCompare(b.center, 'zh-CN'))
    const preferred = ordered[0]
    const area = ordered.find(row => row.area)?.area || ''
    return {
      center: preferred.center,
      area,
      aliases: [...new Set(rows.map(row => row.center))],
    }
  }).sort((a, b) => a.area.localeCompare(b.area, 'zh-CN') || a.center.localeCompare(b.center, 'zh-CN'))
}

export function listServiceCenterOptions(): ServiceCenterOption[] {
  return centerRegistry().map(({ center, area }) => ({ center, area }))
}

export function listAreaOptions(): string[] {
  return [...new Set(centerRegistry().map(option => option.area).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export function resolveAreaSelection(value: unknown): string | null {
  const requested = String(value || '').trim()
  if (!requested) return null
  const matches = listAreaOptions().filter(area => area === requested)
  return matches.length === 1 ? matches[0] : null
}

export function resolveServiceCenterSelection(value: unknown): ServiceCenterOption | null {
  const key = normalizeCollectionCenter(value)
  if (!key) return null
  const matches = centerRegistry().filter(option => option.aliases.some(alias => normalizeCollectionCenter(alias) === key))
  return matches.length === 1 ? { center: matches[0].center, area: matches[0].area } : null
}

export function resolveServiceCenterSelections(value: unknown): ServiceCenterOption[] | null {
  const requested = Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : String(value || '').split(',').map(item => item.trim()).filter(Boolean)
  if (!requested.length) return []
  const resolved = requested.map(resolveServiceCenterSelection)
  if (resolved.some(option => !option)) return null
  return [...new Map(resolved.map(option => [normalizeCollectionCenter(option!.center), option!])).values()]
}

export function serviceCenterValues(user?: ScopeUser): string[] {
  if (!user || user.role === 'admin') return []
  if (user.role === HEADQUARTERS_FUNCTION_ROLE) {
    return user.serviceCenterScope === HEADQUARTERS_FUNCTION_SCOPE
      ? [...new Set(centerRegistry().flatMap(option => option.aliases))]
      : []
  }
  if (user.role === AREA_MANAGER_ROLE) {
    const area = resolveAreaSelection(user.areaScope)
    if (!area || String(user.serviceCenterScope || '').trim()) return []
    return [...new Set(centerRegistry().filter(option => option.area === area).flatMap(option => option.aliases))]
  }
  const selected = resolveServiceCenterSelections(user.serviceCenterScope)
  // 项目经理可兼任同片区多个中心；其他中心级角色仍只能绑定一个。
  if (!selected?.length || (user.role !== PROJECT_MANAGER_ROLE && selected.length !== 1)) return []
  const selectedKeys = new Set(selected.map(option => normalizeCollectionCenter(option.center)))
  return [...new Set(centerRegistry()
    .filter(option => option.aliases.some(alias => selectedKeys.has(normalizeCollectionCenter(alias))))
    .flatMap(option => option.aliases))]
}

export function canonicalServiceCenterForUser(user?: ScopeUser): string | null {
  if (!user || user.role === 'admin') return null
  if (user.role === HEADQUARTERS_FUNCTION_ROLE) return null
  if (user.role === AREA_MANAGER_ROLE) return null
  const selected = resolveServiceCenterSelections(user.serviceCenterScope) || []
  return selected.length === 1 ? selected[0].center : null
}

export function canonicalServiceCentersForUser(user?: ScopeUser): string[] {
  if (!user || user.role === 'admin') return []
  if (user.role === HEADQUARTERS_FUNCTION_ROLE) {
    return user.serviceCenterScope === HEADQUARTERS_FUNCTION_SCOPE
      ? listServiceCenterOptions().map(option => option.center)
      : []
  }
  if (user.role === AREA_MANAGER_ROLE) {
    const area = resolveAreaSelection(user.areaScope)
    if (!area || String(user.serviceCenterScope || '').trim()) return []
    return centerRegistry().filter(option => option.area === area).map(option => option.center)
  }
  const selected = resolveServiceCenterSelections(user.serviceCenterScope) || []
  if (user.role === PROJECT_MANAGER_ROLE) return selected.length > 0 ? selected.map(option => option.center) : []
  return selected.length === 1 ? [selected[0].center] : []
}

export function serviceCenterWhereForUser(
  user: ScopeUser | undefined,
  field: string,
  alias = '',
): { clause: string; params: string[] } {
  if (user?.role === 'admin') return { clause: '', params: [] }
  const centers = serviceCenterValues(user)
  if (!centers.length) return { clause: '1 = 0', params: [] }
  const prefix = alias ? `${alias}.` : ''
  return {
    clause: `${prefix}${field} IN (${centers.map(() => '?').join(',')})`,
    params: centers,
  }
}

export function canAccessServiceCenterForUser(user: ScopeUser | undefined, center: unknown): boolean {
  if (user?.role === 'admin') return true
  const key = normalizeCollectionCenter(center)
  return Boolean(key) && serviceCenterValues(user).some(value => normalizeCollectionCenter(value) === key)
}

export function serviceCenterAreaForUser(user?: ScopeUser): string | null {
  if (user?.role === HEADQUARTERS_FUNCTION_ROLE && user.serviceCenterScope === HEADQUARTERS_FUNCTION_SCOPE) return '全部片区'
  if (user?.role === AREA_MANAGER_ROLE) return resolveAreaSelection(user.areaScope)
  const areas = [...new Set((resolveServiceCenterSelections(user?.serviceCenterScope) || []).map(option => option.area).filter(Boolean))]
  return areas.length === 1 ? areas[0] : null
}
