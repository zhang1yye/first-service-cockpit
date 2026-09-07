import fs from 'node:fs'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import Database from 'better-sqlite3'

const inputPath = process.env.DAILY_RECONCILIATION_FILE
const cockpitRoot = process.env.COCKPIT_ROOT || '/home/ubuntu/cockpit'
const databasePath = process.env.COCKPIT_DB_PATH || path.join(cockpitRoot, 'cockpit.db')
const note = String(process.env.DAILY_RECONCILIATION_NOTE || '次日FineReport官方历史日报专项复核通过').trim()
if (!inputPath || !fs.existsSync(inputPath)) throw new Error('DAILY_RECONCILIATION_FILE missing')
if (note.length < 5) throw new Error('DAILY_RECONCILIATION_NOTE must contain at least 5 characters')

const reconciliation = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
if (!/^\d{4}-\d{2}-\d{2}$/.test(reconciliation.businessDate || '')) throw new Error('invalid businessDate')
if (!Array.isArray(reconciliation.rows) || reconciliation.rows.length !== 61) throw new Error('source rows must equal 61')
for (const row of reconciliation.rows) {
  for (const forbidden of ['annualBudget', 'cumulativeBudget', 'cumulativeExecuted', 'samePeriod']) {
    if (Object.hasOwn(row, forbidden)) throw new Error(`daily-only payload contains forbidden field: ${forbidden}`)
  }
}

const secret = String(process.env.DAILY_RECONCILIATION_JWT_SECRET || '')
if (secret.length < 32) throw new Error('DAILY_RECONCILIATION_JWT_SECRET missing from process environment')
const token = jwt.sign({
  actor: 'daily-reconciliation-automation',
  purpose: 'daily-reconciliation',
  tokenKind: 'automation',
}, secret, {
  algorithm: 'HS256',
  subject: 'daily-reconciliation-automation',
  audience: 'daily-reconciliation-api',
  issuer: 'first-service-cockpit',
  expiresIn: '5m',
})
const headers = { Authorization: ['Bea', 'rer ', token].join(''), 'Content-Type': 'application/json' }

const previewResponse = await fetch('http://127.0.0.1:3002/api/data-pipeline/daily-reconciliations/preview', {
  method: 'POST',
  headers,
  body: JSON.stringify(reconciliation),
})
const previewPayload = await previewResponse.json()
if (!previewResponse.ok) throw new Error(previewPayload.error || previewPayload.batch?.validationErrors?.join('；') || `preview HTTP ${previewResponse.status}`)
const batch = previewPayload.batch
if (batch?.zeroValueAudit === 'requires_business_confirmation') {
  throw new Error('all-zero official daily report requires explicit human business confirmation; automation is fail-closed')
}
if (batch?.totalDifferenceAudit === 'requires_business_confirmation') {
  throw new Error('official-detail total difference requires explicit human business confirmation; automation is fail-closed')
}
const idempotent = batch?.status === 'published'
if (!idempotent && (!batch?.publishable || batch.status !== 'previewed')) throw new Error(`daily reconciliation ${batch?.id} is not publishable`)

if (!idempotent) {
  const publishResponse = await fetch(`http://127.0.0.1:3002/api/data-pipeline/daily-reconciliations/${batch.id}/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ confirmNote: note }),
  })
  const publishPayload = await publishResponse.json()
  if (!publishResponse.ok) throw new Error(publishPayload.error || `publish HTTP ${publishResponse.status}`)
}

const verification = new Database(databasePath, { readonly: true })
const published = verification.prepare(`SELECT id,status,business_date,published_at,published_by,publication_mode,official_total,detail_total,
    zero_value_confirmed,zero_value_confirm_note,total_difference_confirmed,total_difference_confirm_note
  FROM daily_collection_reconciliations WHERE id=?`).get(batch.id)
const mismatch = verification.prepare(`SELECT COUNT(*) AS n
  FROM daily_collection_revision_rows revision
  JOIN daily_collection_reconciliations reconciliation ON reconciliation.id=revision.reconciliation_id
  LEFT JOIN daily_snapshots snapshot ON snapshot.date=reconciliation.business_date AND snapshot.center=revision.center
  WHERE revision.reconciliation_id=? AND (
    snapshot.id IS NULL OR
    snapshot.daily_collection IS NOT revision.new_daily_collection OR
    snapshot.cumulative_budget IS NOT revision.old_cumulative_budget OR
    snapshot.cumulative_executed IS NOT revision.old_cumulative_executed OR
    snapshot.quality_status IS NOT 'verified' OR
    snapshot.source_status IS NOT 'available' OR
    snapshot.business_date IS NOT snapshot.date OR
    snapshot.last_validated_at IS NOT reconciliation.extracted_at OR
    CASE WHEN json_valid(COALESCE(snapshot.field_provenance,'')) <> 1 THEN 1
      WHEN json_extract(snapshot.field_provenance,'$.daily_collection.reportId') IS NOT reconciliation.report_id OR
        json_extract(snapshot.field_provenance,'$.daily_collection.businessDate') IS NOT reconciliation.business_date OR
        json_extract(snapshot.field_provenance,'$.daily_collection.extractedAt') IS NOT reconciliation.extracted_at OR
        json_extract(snapshot.field_provenance,'$.daily_collection.dailyReconciliationId') IS NOT reconciliation.id
      THEN 1 ELSE 0 END = 1
  )`).get(batch.id)
const rowCount = verification.prepare('SELECT COUNT(*) AS n FROM daily_collection_revision_rows WHERE reconciliation_id=?').get(batch.id)
const joinedSnapshotCount = verification.prepare(`SELECT COUNT(snapshot.id) AS n
  FROM daily_collection_revision_rows revision
  JOIN daily_collection_reconciliations reconciliation ON reconciliation.id=revision.reconciliation_id
  LEFT JOIN daily_snapshots snapshot ON snapshot.date=reconciliation.business_date AND snapshot.center=revision.center
  WHERE revision.reconciliation_id=?`).get(batch.id)
const dailyOnlyStatus = verification.prepare(`SELECT COUNT(*) AS revision_count,
    COUNT(DISTINCT revision.center) AS center_count,
    SUM(revision.new_daily_collection) AS revision_total,
    SUM(CASE WHEN payment.center IS NULL THEN 1 ELSE 0 END) AS unknown_centers,
    SUM(CASE WHEN revision.old_daily_collection IS NOT NULL
      OR revision.old_cumulative_budget IS NOT NULL OR revision.old_cumulative_executed IS NOT NULL
      OR revision.old_last_validated_at IS NOT NULL OR revision.old_field_provenance IS NOT '{}'
      THEN 1 ELSE 0 END) AS invalid_lineage
  FROM daily_collection_revision_rows revision
  LEFT JOIN payment_centers payment ON payment.center=revision.center
  WHERE revision.reconciliation_id=?`).get(batch.id)
verification.close()
if (!published || published.status !== 'published' || !published.published_at) throw new Error('published reconciliation read-back failed')
if (Number(rowCount.n) !== 56) throw new Error('canonical revision row count read-back failed')
if (published.publication_mode === 'daily_only') {
  if (Number(dailyOnlyStatus.center_count) !== 56 || Number(dailyOnlyStatus.unknown_centers) !== 0 || Number(dailyOnlyStatus.invalid_lineage) !== 0
    || Math.abs(Number(dailyOnlyStatus.revision_total) - Number(published.detail_total)) > 0.011) {
    throw new Error('published daily-only revision facts failed read-back')
  }
} else {
  if (Number(joinedSnapshotCount.n) !== 56) throw new Error('joined snapshot row count read-back failed')
  if (Number(mismatch.n) !== 0) throw new Error('published daily values, preserved cumulative values, or snapshot metadata failed read-back')
}

console.log(JSON.stringify({
  ok: true,
  id: published.id,
  status: published.status,
  businessDate: published.business_date,
  publishedAt: published.published_at,
  rows: Number(rowCount.n),
  publicationMode: published.publication_mode,
  zeroValueAudit: Number(published.detail_total) === 0
    ? Number(published.zero_value_confirmed) === 1 ? 'business_confirmed' : 'requires_business_confirmation'
    : 'not_applicable',
  zeroValueConfirmNote: published.zero_value_confirm_note,
  totalDifference: Math.round((Number(published.official_total) - Number(published.detail_total) + Number.EPSILON) * 100) / 100,
  totalDifferenceAudit: Math.abs(Number(published.official_total) - Number(published.detail_total)) > 0.011
    ? Number(published.total_difference_confirmed) === 1 ? 'business_confirmed' : 'requires_business_confirmation'
    : 'not_applicable',
  totalDifferenceConfirmNote: published.total_difference_confirm_note,
  officialTotal: batch.officialTotal,
  detailTotal: batch.detailTotal,
  idempotent,
}))
