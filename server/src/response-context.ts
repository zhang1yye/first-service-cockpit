import type { Request } from 'express'

export type DataState = 'ready' | 'partial' | 'unavailable' | 'blocked'
export type PublicationState = 'published' | 'previewed' | 'blocked' | 'unknown'

export type ResponseContextInput = {
  businessDate?: string | null
  extractedAt?: string | null
  sources: string[]
  publicationStatus?: PublicationState
  qualityStatus: DataState
  qualityMessage?: string | null
  batchId?: number | null
  batchSha256?: string | null
  canWrite?: boolean
  canExport?: boolean
}

function csv(value: unknown): string[] {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean)
}

function dateOnly(value: unknown): string | null {
  const matched = String(value || '').match(/^\d{4}-\d{2}-\d{2}/)
  return matched?.[0] || null
}

/**
 * 新接口统一附带的事实上下文。旧业务字段保持不变，迁移期间以 `meta` 增量接入，
 * 避免为了补元数据破坏已经验收的页面和API。
 */
export function buildResponseContext(req: Request, input: ResponseContextInput) {
  const user = (req as any).user || {}
  const admin = user.role === 'admin'
  const headquartersFunction = user.role === 'hq_function'
    && user.serviceCenterScope === '华北地区公司本部职能'
  const allAuthorizedServiceCenters = admin || headquartersFunction
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: {
      role: user.role || 'unknown',
      areaScope: allAuthorizedServiceCenters ? null : csv(user.areaScope),
      serviceCenterScope: allAuthorizedServiceCenters ? null : csv(user.serviceCenterScope),
      allAuthorizedServiceCenters,
    },
    freshness: {
      businessDate: dateOnly(input.businessDate),
      extractedAt: input.extractedAt || null,
      state: input.qualityStatus,
    },
    provenance: {
      sources: [...new Set(input.sources.filter(Boolean))],
      batchId: input.batchId ?? null,
      batchSha256: input.batchSha256 || null,
      publicationStatus: input.publicationStatus || 'unknown',
      qualityStatus: input.qualityStatus,
      qualityMessage: input.qualityMessage || null,
    },
    permissions: {
      read: true,
      write: admin && Boolean(input.canWrite),
      export: input.canExport !== false,
    },
  }
}
