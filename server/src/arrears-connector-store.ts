import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { NormalizedLvzaiEnvelope } from './arrears-connectors.js'
import type { NormalizedWecomLedgerEnvelope } from './wecom-ledger-connector.js'
import type { NormalizedQxmEvidenceEnvelope } from './qxm-evidence-connector.js'

export type LvzaiPublicationResult = {
  runId: number
  idempotent: boolean
  source: 'lvzai'
  businessDate: string
  rowCount: number
  uniqueHouseCount: number
  totalAmount: number
  evidenceSha256: string
}

function publicationHash(payload: NormalizedLvzaiEnvelope): string {
  const evidence = [...payload.rows].map(row => row.sourceEvidenceHash).sort()
  return crypto.createHash('sha256').update(JSON.stringify({
    source: payload.source,
    businessDate: payload.businessDate,
    rowCount: payload.quality.rowCount,
    uniqueHouseCount: payload.quality.uniqueHouseCount,
    totalAmount: payload.quality.totalAmount,
    evidence,
  })).digest('hex')
}

function maskHouse(value: string): string {
  const parts = value.split('-')
  if (parts.length !== 5) return '房屋号已脱敏'
  const room = parts[4]
  const maskedRoom = room.length <= 2 ? '**' : `${room.slice(0, 1)}${'*'.repeat(Math.max(2, room.length - 2))}${room.slice(-1)}`
  return `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}-${maskedRoom}`
}

export function publishLvzaiArrears(
  database: Database.Database,
  payload: NormalizedLvzaiEnvelope,
): LvzaiPublicationResult {
  if (payload.source !== 'lvzai' || payload.quality.state !== 'passed') throw new Error('只允许发布通过质量门禁的绿仔逐户欠费数据')
  if (payload.rows.length !== payload.quality.rowCount || !payload.rows.length) throw new Error('绿仔发布行数与质量回执不一致')
  const evidenceSha256 = publicationHash(payload)
  const existing = database.prepare(`
    SELECT id,status FROM arrears_source_sync_runs
    WHERE source='lvzai' AND business_date=? AND evidence_sha256=?
  `).get(payload.businessDate, evidenceSha256) as { id: number; status: string } | undefined
  if (existing?.status === 'superseded') throw new Error('拒绝重新发布已被更新批次替代的绿仔欠费证据')
  if (existing) {
    return {
      runId: existing.id,
      idempotent: true,
      source: 'lvzai',
      businessDate: payload.businessDate,
      rowCount: payload.quality.rowCount,
      uniqueHouseCount: payload.quality.uniqueHouseCount,
      totalAmount: payload.quality.totalAmount,
      evidenceSha256,
    }
  }

  return database.transaction(() => {
    database.prepare(`
      UPDATE arrears_source_sync_runs SET status='superseded'
      WHERE source='lvzai' AND business_date=? AND status='published'
    `).run(payload.businessDate)
    const run = database.prepare(`
      INSERT INTO arrears_source_sync_runs
        (source,business_date,extracted_at,status,row_count,unique_house_count,total_amount,quality_json,evidence_sha256)
      VALUES ('lvzai',?,?, 'published',?,?,?,?,?)
    `).run(
      payload.businessDate,
      payload.extractedAt,
      payload.quality.rowCount,
      payload.quality.uniqueHouseCount,
      payload.quality.totalAmount,
      JSON.stringify(payload.quality),
      evidenceSha256,
    )
    const runId = Number(run.lastInsertRowid)
    const insert = database.prepare(`
      INSERT INTO arrears_lvzai_facts
        (run_id,source_row,house_hash,house_masked,service_center,room_id_hash,person_id_hash,fee_item,amount,period_start,period_end,payment_status,evidence_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    payload.rows.forEach((row, index) => insert.run(
      runId,
      index + 1,
      row.houseHash,
      maskHouse(row.houseDisplay),
      row.serviceCenter,
      row.roomIdHash,
      row.personIdHash,
      row.feeItem,
      row.amount,
      row.periodStart,
      row.periodEnd,
      row.paymentStatus,
      row.sourceEvidenceHash,
    ))
    const inserted = Number((database.prepare('SELECT COUNT(*) AS count FROM arrears_lvzai_facts WHERE run_id=?').get(runId) as any).count || 0)
    if (inserted !== payload.quality.rowCount) throw new Error('绿仔逐户欠费发布完整性复核失败')
    return {
      runId,
      idempotent: false,
      source: 'lvzai' as const,
      businessDate: payload.businessDate,
      rowCount: payload.quality.rowCount,
      uniqueHouseCount: payload.quality.uniqueHouseCount,
      totalAmount: payload.quality.totalAmount,
      evidenceSha256,
    }
  })()
}

export function readArrearsConnectorStatus(database: Database.Database, source: 'lvzai' | 'wecom_ledger' | 'qxm' = 'lvzai'): {
  source: 'lvzai' | 'wecom_ledger' | 'qxm'
  state: 'published' | 'not_connected'
  businessDate: string | null
  extractedAt: string | null
  rowCount: number
  uniqueHouseCount: number
  totalAmount: number | null
  quality: Record<string, unknown> | null
} {
  const row = database.prepare(`
    SELECT business_date,extracted_at,row_count,unique_house_count,total_amount,quality_json
    FROM arrears_source_sync_runs
    WHERE source=? AND status='published'
    ORDER BY business_date DESC,id DESC LIMIT 1
  `).get(source) as any
  if (!row) return { source, state: 'not_connected', businessDate: null, extractedAt: null, rowCount: 0, uniqueHouseCount: 0, totalAmount: null, quality: null }
  let quality: Record<string, unknown> | null = null
  try { quality = JSON.parse(String(row.quality_json || 'null')) } catch {}
  return {
    source,
    state: 'published',
    businessDate: String(row.business_date),
    extractedAt: String(row.extracted_at),
    rowCount: Number(row.row_count || 0),
    uniqueHouseCount: Number(row.unique_house_count || 0),
    totalAmount: row.total_amount === null ? null : Number(row.total_amount),
    quality,
  }
}

export type QxmShardCoverageRow = {
  serviceCenter: string
  state: 'passed' | 'failed'
  businessDate: string
  extractedAt: string
  errorCode: string | null
  rowCount: number
  matchedCount: number
  isolatedCount: number
  matchRate: number | null
  cursorAdvanced: boolean
}

export function readQxmShardCoverage(database: Database.Database, options: { serviceCenters?: string[] } = {}): {
  summary: { total: number; passed: number; failed: number }
  rows: QxmShardCoverageRow[]
} {
  const centers = [...new Set((options.serviceCenters || []).map(value => String(value || '').trim()).filter(Boolean))]
  const where = centers.length ? `WHERE service_center IN (${centers.map(() => '?').join(',')})` : ''
  const rawRows = database.prepare(`SELECT service_center,state,business_date,extracted_at,error_code,row_count,matched_count,isolated_count,cursor_advanced FROM arrears_qxm_shard_status ${where} ORDER BY service_center`).all(...centers) as any[]
  const rows = rawRows.map(row => {
    const rowCount = Number(row.row_count || 0)
    const matchedCount = Number(row.matched_count || 0)
    return {
      serviceCenter: String(row.service_center),
      state: row.state === 'passed' ? 'passed' as const : 'failed' as const,
      businessDate: String(row.business_date),
      extractedAt: String(row.extracted_at),
      errorCode: row.error_code ? String(row.error_code) : null,
      rowCount,
      matchedCount,
      isolatedCount: Number(row.isolated_count || 0),
      matchRate: rowCount > 0 ? matchedCount / rowCount : null,
      cursorAdvanced: Number(row.cursor_advanced) === 1,
    }
  })
  return {
    summary: { total: rows.length, passed: rows.filter(row => row.state === 'passed').length, failed: rows.filter(row => row.state === 'failed').length },
    rows,
  }
}

export type WecomLedgerPublicationResult = {
  runId: number
  idempotent: boolean
  source: 'wecom_ledger'
  businessDate: string
  rowCount: number
  uniqueHouseCount: number
  evidenceSha256: string
}

function wecomPublicationHash(payload: NormalizedWecomLedgerEnvelope): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    source: payload.source,
    businessDate: payload.businessDate,
    rowCount: payload.quality.rowCount,
    uniqueHouseCount: payload.quality.uniqueHouseCount,
    evidence: payload.rows.map(row => row.evidenceHash).sort(),
  })).digest('hex')
}

export function publishWecomLedger(database: Database.Database, payload: NormalizedWecomLedgerEnvelope): WecomLedgerPublicationResult {
  if (payload.source !== 'wecom_ledger' || payload.quality.state !== 'passed') throw new Error('只允许发布通过质量门禁的企业微信欠费台账')
  if (payload.rows.length !== payload.quality.rowCount || !payload.rows.length || payload.quality.authoritativeAmountFields !== 0) throw new Error('企业微信台账发布回执不完整或包含权威金额')
  const evidenceSha256 = wecomPublicationHash(payload)
  const existing = database.prepare(`SELECT id,status FROM arrears_source_sync_runs WHERE source='wecom_ledger' AND business_date=? AND evidence_sha256=?`).get(payload.businessDate, evidenceSha256) as { id: number; status: string } | undefined
  if (existing?.status === 'superseded') throw new Error('拒绝重新发布已被更新批次替代的企业微信台账证据')
  if (existing) return { runId: existing.id, idempotent: true, source: 'wecom_ledger', businessDate: payload.businessDate, rowCount: payload.quality.rowCount, uniqueHouseCount: payload.quality.uniqueHouseCount, evidenceSha256 }

  return database.transaction(() => {
    database.prepare(`UPDATE arrears_source_sync_runs SET status='superseded' WHERE source='wecom_ledger' AND business_date=? AND status='published'`).run(payload.businessDate)
    const run = database.prepare(`
      INSERT INTO arrears_source_sync_runs
        (source,business_date,extracted_at,status,row_count,unique_house_count,total_amount,quality_json,evidence_sha256)
      VALUES ('wecom_ledger',?,?, 'published',?,?,NULL,?,?)
    `).run(payload.businessDate, payload.extractedAt, payload.quality.rowCount, payload.quality.uniqueHouseCount, JSON.stringify(payload.quality), evidenceSha256)
    const runId = Number(run.lastInsertRowid)
    const insert = database.prepare(`
      INSERT INTO arrears_wecom_ledger_facts
        (run_id,source_row,house_hash,house_masked,service_center,document_id_hash,sheet_id_hash,record_id_hash,manual_cause,progress,latest_followup_date,promised_payment_date,responsible_user_id_hash,evidence_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    payload.rows.forEach((row, index) => insert.run(runId, index + 1, row.houseHash, maskHouse(row.houseDisplay), row.serviceCenter, row.documentIdHash, row.sheetIdHash, row.recordIdHash, row.manualCause, row.progress, row.latestFollowupDate, row.promisedPaymentDate, row.responsibleUserIdHash, row.evidenceHash))
    const inserted = Number((database.prepare('SELECT COUNT(*) count FROM arrears_wecom_ledger_facts WHERE run_id=?').get(runId) as any).count || 0)
    if (inserted !== payload.quality.rowCount) throw new Error('企业微信台账发布完整性复核失败')
    return { runId, idempotent: false, source: 'wecom_ledger' as const, businessDate: payload.businessDate, rowCount: payload.quality.rowCount, uniqueHouseCount: payload.quality.uniqueHouseCount, evidenceSha256 }
  })()
}

export type QxmPublicationResult = {
  runId: number
  idempotent: boolean
  source: 'qxm'
  businessDate: string
  rowCount: number
  insertedCount: number
  existingCount: number
  evidenceSha256: string
}

function qxmPublicationHash(payload: NormalizedQxmEvidenceEnvelope): string {
  return crypto.createHash('sha256').update(JSON.stringify({ source: payload.source, businessDate: payload.businessDate, rowCount: payload.quality.rowCount, evidence: payload.rows.map(row => row.sourceEvidenceHash).sort() })).digest('hex')
}

export function publishQxmEvidence(database: Database.Database, payload: NormalizedQxmEvidenceEnvelope): QxmPublicationResult {
  if (payload.source !== 'qxm' || payload.quality.state !== 'passed' || payload.rows.length !== payload.quality.rowCount) throw new Error('只允许发布通过质量门禁的企小码证据')
  const evidenceSha256 = qxmPublicationHash(payload)
  const existingRun = database.prepare(`SELECT id FROM arrears_source_sync_runs WHERE source='qxm' AND business_date=? AND evidence_sha256=?`).get(payload.businessDate, evidenceSha256) as { id: number } | undefined
  if (existingRun) return { runId: existingRun.id, idempotent: true, source: 'qxm', businessDate: payload.businessDate, rowCount: payload.quality.rowCount, insertedCount: 0, existingCount: payload.quality.rowCount, evidenceSha256 }
  let existingCount = 0
  for (const row of payload.rows) {
    const existing = database.prepare('SELECT evidence_sha256 FROM arrears_qxm_evidence WHERE message_id_hash=?').get(row.messageIdHash) as { evidence_sha256: string } | undefined
    if (!existing) continue
    if (existing.evidence_sha256 !== row.sourceEvidenceHash) throw new Error('企小码稳定消息ID对应的证据内容发生冲突')
    existingCount += 1
  }
  return database.transaction(() => {
    const uniqueHouses = new Set(payload.rows.map(row => row.houseHash).filter(Boolean)).size
    const run = database.prepare(`INSERT INTO arrears_source_sync_runs
      (source,business_date,extracted_at,status,row_count,unique_house_count,total_amount,quality_json,evidence_sha256)
      VALUES ('qxm',?,?, 'published',?,?,NULL,?,?)`).run(payload.businessDate, payload.extractedAt, payload.quality.rowCount, uniqueHouses, JSON.stringify(payload.quality), evidenceSha256)
    const runId = Number(run.lastInsertRowid)
    const insert = database.prepare(`INSERT INTO arrears_qxm_evidence
      (run_id,source_row,service_center,match_state,house_hash,house_masked,room_reference_hash,message_id_hash,external_user_id_hash,employee_user_id_hash,occurred_at,direction,content_kind,signal_state,cause_signal,evidence_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    let insertedCount = 0
    payload.rows.forEach((row, index) => {
      const existing = database.prepare('SELECT 1 FROM arrears_qxm_evidence WHERE message_id_hash=?').get(row.messageIdHash)
      if (existing) return
      insert.run(runId, index + 1, row.serviceCenter, row.matchState, row.houseHash, row.houseDisplay ? maskHouse(row.houseDisplay) : '房屋号未关联', row.roomReferenceHash, row.messageIdHash, row.externalUserIdHash, row.employeeUserIdHash, row.occurredAt, row.direction, row.contentKind, row.signalState, row.causeSignal, row.sourceEvidenceHash)
      insertedCount += 1
    })
    if (insertedCount + existingCount !== payload.quality.rowCount) throw new Error('企小码证据发布完整性复核失败')
    return { runId, idempotent: false, source: 'qxm' as const, businessDate: payload.businessDate, rowCount: payload.quality.rowCount, insertedCount, existingCount, evidenceSha256 }
  })()
}

export type ArrearsConflictDecision = 'confirmed' | 'rejected'
export type ArrearsConflictReasonCode = 'source_lag' | 'mapping_error' | 'ledger_stale' | 'lvzai_status_confirmed' | 'source_correction_required' | 'not_a_conflict'

export type ArrearsEvidenceConflict = {
  conflictKey: string
  type: 'service_center_mismatch' | 'reported_paid_but_lvzai_arrears' | 'wecom_without_current_lvzai' | 'lvzai_without_wecom_ledger' | 'lvzai_without_qxm_evidence' | 'qxm_without_current_lvzai' | 'qxm_room_review_required' | 'qxm_signal_conflicted'
  houseHash: string
  houseMasked: string
  serviceCenter: string
  lvzaiBusinessDate: string | null
  wecomBusinessDate: string | null
  qxmBusinessDate: string | null
  authoritativeArrearsAmount: number | null
  latestFollowupDate: string
  evidenceRefs: string[]
  review: { decision: ArrearsConflictDecision; reasonCode: ArrearsConflictReasonCode; reviewedAt: string; version: number } | null
}

export function readArrearsEvidenceConflicts(database: Database.Database, options: {
  limit?: number
  offset?: number
  serviceCenters?: string[]
  type?: ArrearsEvidenceConflict['type']
  conflictKey?: string
} = {}): {
  counts: Record<ArrearsEvidenceConflict['type'], number>
  total: number
  rows: ArrearsEvidenceConflict[]
  truncated: boolean
} {
  const lvzaiRun = database.prepare(`SELECT id,business_date FROM arrears_source_sync_runs WHERE source='lvzai' AND status='published' ORDER BY business_date DESC,id DESC LIMIT 1`).get() as any
  const wecomRun = database.prepare(`SELECT id,business_date FROM arrears_source_sync_runs WHERE source='wecom_ledger' AND status='published' ORDER BY business_date DESC,id DESC LIMIT 1`).get() as any
  const qxmRun = database.prepare(`SELECT id,business_date FROM arrears_source_sync_runs WHERE source='qxm' AND status='published' ORDER BY business_date DESC,id DESC LIMIT 1`).get() as any
  const lvzaiRows = lvzaiRun ? database.prepare(`SELECT house_hash,MAX(house_masked) house_masked,MAX(service_center) service_center,SUM(amount) amount,GROUP_CONCAT(evidence_sha256) evidence FROM arrears_lvzai_facts WHERE run_id=? GROUP BY house_hash`).all(lvzaiRun.id) as any[] : []
  const wecomRows = wecomRun ? database.prepare(`SELECT house_hash,MAX(house_masked) house_masked,MAX(service_center) service_center,MAX(latest_followup_date) latest_followup_date,MAX(CASE WHEN progress='reported_paid_pending_lvzai' THEN 1 ELSE 0 END) reported_paid,GROUP_CONCAT(evidence_sha256) evidence FROM arrears_wecom_ledger_facts WHERE run_id=? GROUP BY house_hash`).all(wecomRun.id) as any[] : []
  const qxmRows = qxmRun ? database.prepare(`SELECT house_hash,MAX(house_masked) house_masked,MAX(service_center) service_center,MAX(occurred_at) occurred_at,MAX(CASE WHEN signal_state='conflicted' THEN 1 ELSE 0 END) signal_conflicted,GROUP_CONCAT(evidence_sha256) evidence FROM arrears_qxm_evidence WHERE match_state='matched' GROUP BY house_hash`).all() as any[] : []
  const lvzai = new Map(lvzaiRows.map(row => [String(row.house_hash), row]))
  const wecom = new Map(wecomRows.map(row => [String(row.house_hash), row]))
  const qxm = new Map(qxmRows.map(row => [String(row.house_hash), row]))
  const conflicts: ArrearsEvidenceConflict[] = []
  for (const houseHash of new Set([...lvzai.keys(), ...wecom.keys()])) {
    const authority = lvzai.get(houseHash), ledger = wecom.get(houseHash)
    let type: ArrearsEvidenceConflict['type'] | null = null
    if (authority && ledger && String(authority.service_center) !== String(ledger.service_center)) type = 'service_center_mismatch'
    else if (authority && ledger && Number(ledger.reported_paid) === 1 && Number(authority.amount) > 0) type = 'reported_paid_but_lvzai_arrears'
    else if (ledger && !authority) type = 'wecom_without_current_lvzai'
    else if (authority && !ledger) type = 'lvzai_without_wecom_ledger'
    if (!type) continue
    const hashes = [...String(authority?.evidence || '').split(','), ...String(ledger?.evidence || '').split(',')].filter(Boolean)
    const conflictKey = crypto.createHash('sha256').update(JSON.stringify({ type, houseHash, lvzaiRunId: lvzaiRun?.id || null, wecomRunId: wecomRun?.id || null })).digest('hex')
    conflicts.push({ conflictKey, type, houseHash, houseMasked: String(authority?.house_masked || ledger?.house_masked || '房屋号已脱敏'), serviceCenter: String(authority?.service_center || ledger?.service_center || ''), lvzaiBusinessDate: lvzaiRun ? String(lvzaiRun.business_date) : null, wecomBusinessDate: wecomRun ? String(wecomRun.business_date) : null, qxmBusinessDate: null, authoritativeArrearsAmount: authority ? Number(authority.amount) : null, latestFollowupDate: String(ledger?.latest_followup_date || ''), evidenceRefs: hashes.map((hash, index) => `${index < String(authority?.evidence || '').split(',').filter(Boolean).length ? 'LZ' : 'WX'}-${hash.slice(0, 12)}`), review: null })
  }
  const addQxmConflict = (type: ArrearsEvidenceConflict['type'], identity: string, authority: any, communication: any) => {
    const evidence = String(communication?.evidence || authority?.evidence || '').split(',').filter(Boolean)
    const conflictKey = crypto.createHash('sha256').update(JSON.stringify({ type, identity, lvzaiRunId: lvzaiRun?.id || null, qxmRunId: qxmRun?.id || null })).digest('hex')
    conflicts.push({ conflictKey, type, houseHash: identity, houseMasked: String(authority?.house_masked || communication?.house_masked || '房屋号待复核'), serviceCenter: String(authority?.service_center || communication?.service_center || ''), lvzaiBusinessDate: lvzaiRun ? String(lvzaiRun.business_date) : null, wecomBusinessDate: null, qxmBusinessDate: qxmRun ? String(qxmRun.business_date) : null, authoritativeArrearsAmount: authority ? Number(authority.amount) : null, latestFollowupDate: String(communication?.occurred_at || ''), evidenceRefs: evidence.map(hash => `${communication ? 'QX' : 'LZ'}-${hash.slice(0, 12)}`), review: null })
  }
  if (qxmRun) {
    for (const [houseHash, authority] of lvzai) if (!qxm.has(houseHash)) addQxmConflict('lvzai_without_qxm_evidence', houseHash, authority, null)
    for (const [houseHash, communication] of qxm) {
      const authority = lvzai.get(houseHash)
      if (Number(communication.signal_conflicted) === 1) addQxmConflict('qxm_signal_conflicted', houseHash, authority, communication)
    }
  }
  const reviews = new Map<string, { decision: ArrearsConflictDecision; reasonCode: ArrearsConflictReasonCode; reviewedAt: string; version: number }>()
  const conflictKeys = conflicts.map(row => row.conflictKey)
  for (let index = 0; index < conflictKeys.length; index += 500) {
    const keys = conflictKeys.slice(index, index + 500)
    const reviewRows = database.prepare(`SELECT conflict_key,decision,reason_code,reviewed_at,version FROM arrears_evidence_conflict_reviews WHERE conflict_key IN (${keys.map(() => '?').join(',')})`).all(...keys) as any[]
    reviewRows.forEach(row => reviews.set(String(row.conflict_key), { decision: row.decision as ArrearsConflictDecision, reasonCode: row.reason_code as ArrearsConflictReasonCode, reviewedAt: String(row.reviewed_at), version: Number(row.version) }))
  }
  conflicts.forEach(row => { row.review = reviews.get(row.conflictKey) || null })
  const order: ArrearsEvidenceConflict['type'][] = ['service_center_mismatch', 'reported_paid_but_lvzai_arrears', 'qxm_room_review_required', 'qxm_signal_conflicted', 'wecom_without_current_lvzai', 'qxm_without_current_lvzai', 'lvzai_without_wecom_ledger', 'lvzai_without_qxm_evidence']
  conflicts.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || Number(b.authoritativeArrearsAmount || 0) - Number(a.authoritativeArrearsAmount || 0) || a.houseHash.localeCompare(b.houseHash))
  const allowed = options.serviceCenters?.length ? new Set(options.serviceCenters) : null
  const scoped = allowed ? conflicts.filter(row => allowed.has(row.serviceCenter)) : conflicts
  const counts: Record<ArrearsEvidenceConflict['type'], number> = { service_center_mismatch: 0, reported_paid_but_lvzai_arrears: 0, wecom_without_current_lvzai: 0, lvzai_without_wecom_ledger: 0, lvzai_without_qxm_evidence: 0, qxm_without_current_lvzai: 0, qxm_room_review_required: 0, qxm_signal_conflicted: 0 }
  scoped.forEach(row => { counts[row.type] += 1 })
  const typed = options.type ? scoped.filter(row => row.type === options.type) : scoped
  const filtered = options.conflictKey ? typed.filter(row => row.conflictKey === options.conflictKey) : typed
  const boundedLimit = Math.max(1, Math.min(2000, Math.trunc(options.limit || 500)))
  const offset = Math.max(0, Math.trunc(options.offset || 0))
  return { counts, total: filtered.length, rows: filtered.slice(offset, offset + boundedLimit), truncated: filtered.length > offset + boundedLimit }
}

export function reviewArrearsEvidenceConflict(database: Database.Database, input: {
  conflict: ArrearsEvidenceConflict
  decision: ArrearsConflictDecision
  reasonCode: ArrearsConflictReasonCode
  expectedVersion: number
  reviewedByUserId: number | null
  lvzaiRunId: number | null
  wecomRunId: number | null
  qxmRunId: number | null
}): { conflictKey: string; decision: ArrearsConflictDecision; reasonCode: ArrearsConflictReasonCode; version: number } {
  const decisions = new Set<ArrearsConflictDecision>(['confirmed', 'rejected'])
  const reasons = new Set<ArrearsConflictReasonCode>(['source_lag', 'mapping_error', 'ledger_stale', 'lvzai_status_confirmed', 'source_correction_required', 'not_a_conflict'])
  if (!decisions.has(input.decision) || !reasons.has(input.reasonCode)) throw new Error('冲突复核决定或原因代码无效')
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('冲突复核版本无效')
  if (!/^[a-f0-9]{64}$/.test(input.conflict.conflictKey)) throw new Error('冲突复核键无效')
  const existing = database.prepare('SELECT version FROM arrears_evidence_conflict_reviews WHERE conflict_key=?').get(input.conflict.conflictKey) as { version: number } | undefined
  if (!existing) {
    if (input.expectedVersion !== 0) throw new Error('冲突复核版本冲突，请刷新后重试')
    database.prepare(`INSERT INTO arrears_evidence_conflict_reviews
      (conflict_key,conflict_type,house_hash,service_center,lvzai_run_id,wecom_run_id,qxm_run_id,decision,reason_code,reviewed_by_user_id,version)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)`).run(input.conflict.conflictKey, input.conflict.type, input.conflict.houseHash, input.conflict.serviceCenter, input.lvzaiRunId, input.wecomRunId, input.qxmRunId, input.decision, input.reasonCode, input.reviewedByUserId)
    return { conflictKey: input.conflict.conflictKey, decision: input.decision, reasonCode: input.reasonCode, version: 1 }
  }
  const update = database.prepare(`UPDATE arrears_evidence_conflict_reviews SET decision=?,reason_code=?,reviewed_by_user_id=?,reviewed_at=datetime('now','localtime'),version=version+1 WHERE conflict_key=? AND version=?`).run(input.decision, input.reasonCode, input.reviewedByUserId, input.conflict.conflictKey, input.expectedVersion)
  if (update.changes !== 1) throw new Error('冲突复核版本冲突，请刷新后重试')
  return { conflictKey: input.conflict.conflictKey, decision: input.decision, reasonCode: input.reasonCode, version: input.expectedVersion + 1 }
}
