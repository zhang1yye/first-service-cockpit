import { Router } from 'express'
import db from '../db.js'

export const REQUIRED_TABLES = [
  'users',
  'projects',
  'weekly_meetings',
  'weekly_meeting_items',
  'project_forecasts',
  'operation_logs',
] as const

type DbLike = {
  prepare: (sql: string) => {
    get?: () => unknown
    all?: () => unknown[]
  }
}

type CheckStatus = 'ok' | 'failed' | 'unknown'

type ReadinessBody = {
  status: 'ok' | 'unavailable'
  ready: boolean
  checks: {
    database: CheckStatus
    schema: CheckStatus
  }
}

export function livePayload() {
  return { status: 'ok' as const, live: true as const }
}

export function evaluateReadiness(database: DbLike): { httpStatus: 200 | 503; body: ReadinessBody } {
  try {
    database.prepare('SELECT 1 AS ok').get?.()
    const rows = (database.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(name => `'${name}'`).join(',')})`,
    ).all?.() || []) as Array<{ name?: string }>
    const present = new Set(rows.map(row => row.name).filter(Boolean))
    const schemaReady = REQUIRED_TABLES.every(name => present.has(name))
    if (!schemaReady) {
      return {
        httpStatus: 503,
        body: {
          status: 'unavailable',
          ready: false,
          checks: { database: 'ok', schema: 'failed' },
        },
      }
    }
    return {
      httpStatus: 200,
      body: {
        status: 'ok',
        ready: true,
        checks: { database: 'ok', schema: 'ok' },
      },
    }
  } catch {
    return {
      httpStatus: 503,
      body: {
        status: 'unavailable',
        ready: false,
        checks: { database: 'failed', schema: 'unknown' },
      },
    }
  }
}

const router = Router()

router.get('/api/health', (_req, res) => res.json(livePayload()))
router.get('/api/health/live', (_req, res) => res.json(livePayload()))
router.get('/api/health/ready', (_req, res) => {
  const result = evaluateReadiness(db)
  res.status(result.httpStatus).json(result.body)
})

export default router
