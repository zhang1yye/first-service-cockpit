import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-daily-reconciliation-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'x'.repeat(40)
process.env.NODE_ENV = 'test'

const [{ default: db }, reconciliation] = await Promise.all([
  import('../src/db.js'),
  import('../src/daily-reconciliation.js'),
])

const center = '第一服务历史日报复核服务中心'
const mergeGroups = [
  { sources: ['第一服务北京满庭芳园服务中心', '第一服务北京青云大厦服务中心'], target: '第一服务满庭青云服务中心' },
  { sources: ['第一服务北京西山上品湾MOMΛ服务中心', '第一服务北京西山上品湾二期MOMΛ服务中心'], target: '第一服务北京西山上品湾MOMΛ服务中心' },
  { sources: ['第一服务北京上第MOMΛ服务中心', '第一服务北京IMOMΛ服务中心', '第一服务北京悦MOMΛ服务中心'], target: '第一服务北京上第MOMΛ服务中心' },
  { sources: ['第一服务北京MOMΛ万万树服务中心一期', '第一服务北京MOMΛ万万树服务中心二期'], target: '第一服务北京MOMΛ万万树服务中心' },
]
const canonicalCenters = [...mergeGroups.map((group) => group.target), center, ...Array.from({ length: 51 }, (_, index) => `第一服务测试${String(index + 1).padStart(2, '0')}服务中心`)]
const rawCenters = canonicalCenters.flatMap((canonical) => mergeGroups.find((group) => group.target === canonical)?.sources || [canonical])
const rawRows = (daily: number) => rawCenters.map((rawCenter) => ({ center: rawCenter, dailyCollection: rawCenter === center ? daily : 0 }))

const insertPayment = db.prepare(`INSERT INTO payment_centers
  (area,center,annual_budget,cumulative_budget,cumulative_executed,same_period,collection_rate)
  VALUES('华北',?,200,160,128.18,100,NULL)`)
const insertSnapshot = db.prepare(`INSERT INTO daily_snapshots
  (date,center,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
   quality_status,quality_reason,source,source_status,last_validated_at,field_provenance)
  VALUES('2026-08-29',?,'2026-08-29',200,160,128.18,0,
   'verified','17:30原始质量说明','FineReport三报表中心明细','available','2026-08-29T17:30:00+08:00','{}')`)
for (const canonical of canonicalCenters) {
  insertPayment.run(canonical)
  insertSnapshot.run(canonical)
}
const nullDailyCenter = canonicalCenters.at(-1)!
db.prepare(`UPDATE daily_snapshots SET daily_collection=NULL WHERE date='2026-08-29' AND center=?`).run(nullDailyCenter)

after(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('正式历史日报复核只修订daily_collection并保留17:30累计快照', () => {
  const preview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-30T08:30:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 12.34,
    rows: rawRows(12.34),
  }, 'tester')
  assert.equal(preview.status, 'previewed')
  assert.equal(preview.sourceRowCount, 61)

  const before = db.prepare(`SELECT annual_budget,cumulative_budget,cumulative_executed,daily_collection,
    last_validated_at,field_provenance FROM daily_snapshots WHERE date='2026-08-29' AND center=?`).get(center) as any

  const published = reconciliation.publishDailyReconciliation(db, preview.id, 'tester', '次日官方日报复核通过')
  assert.equal(published.status, 'published')

  const afterRow = db.prepare(`SELECT annual_budget,cumulative_budget,cumulative_executed,daily_collection,
    last_validated_at,field_provenance FROM daily_snapshots WHERE date='2026-08-29' AND center=?`).get(center) as any
  assert.equal(afterRow.annual_budget, before.annual_budget)
  assert.equal(afterRow.cumulative_budget, before.cumulative_budget)
  assert.equal(afterRow.cumulative_executed, before.cumulative_executed)
  assert.equal(afterRow.daily_collection, 12.34)
  assert.notEqual(afterRow.last_validated_at, before.last_validated_at)
  assert.match(afterRow.field_provenance, /dailyReconciliationId/)
  const metadata = db.prepare(`SELECT quality_status,quality_reason,source,source_status FROM daily_snapshots
    WHERE date='2026-08-29' AND center=?`).get(center) as any
  assert.deepEqual(metadata, {
    quality_status: 'verified',
    quality_reason: '17:30原始质量说明',
    source: 'FineReport三报表中心明细',
    source_status: 'available',
  })
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM daily_collection_revision_rows WHERE reconciliation_id=?').get(preview.id) as any).n, 56)
  assert.equal((db.prepare('SELECT old_daily_collection AS oldDaily FROM daily_collection_revision_rows WHERE reconciliation_id=? AND center=?').get(preview.id, nullDailyCenter) as any).oldDaily, null)

  const revision = db.prepare(`SELECT old_daily_collection,new_daily_collection,
    old_cumulative_budget,old_cumulative_executed FROM daily_collection_revision_rows
    WHERE reconciliation_id=? AND center=?`).get(preview.id, center) as any
  assert.deepEqual(revision, {
    old_daily_collection: 0,
    new_daily_collection: 12.34,
    old_cumulative_budget: 160,
    old_cumulative_executed: 128.18,
  })
})

test('相同官方内容仅提取时间变化时保持幂等', () => {
  const existing = db.prepare("SELECT id FROM daily_collection_reconciliations WHERE business_date='2026-08-29' AND status='published'").get() as any
  const repeated = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-31T08:30:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 12.34,
    rows: rawRows(12.34),
    unexpectedTransportField: 'ignored-for-business-identity',
  } as any, 'scheduler')

  assert.equal(repeated.id, existing.id)
  assert.equal(repeated.status, 'published')
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM daily_collection_reconciliations WHERE business_date='2026-08-29'").get() as any).n, 1)
})

test('相同官方内容对应的已发布快照漂移后会生成可发布修复批次且不再无限重试', () => {
  const original = db.prepare("SELECT id FROM daily_collection_reconciliations WHERE business_date='2026-08-29' AND status='published'").get() as any
  db.prepare("UPDATE daily_snapshots SET daily_collection=99 WHERE date='2026-08-29' AND center=?").run(center)
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), false)

  const payload = {
    schemaVersion: 1 as const,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-31T08:30:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 12.34,
    rows: rawRows(12.34),
  }
  const repair = reconciliation.previewDailyReconciliation(db, payload, 'scheduler')
  assert.equal(repair.status, 'previewed')
  assert.notEqual(repair.id, original.id)
  const published = reconciliation.publishDailyReconciliation(db, repair.id, 'scheduler', '修复已发布快照漂移')
  assert.equal(published.status, 'published')
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), true)

  const repeated = reconciliation.previewDailyReconciliation(db, payload, 'scheduler')
  assert.equal(repeated.id, repair.id)
  assert.equal(repeated.status, 'published')
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM daily_collection_reconciliations WHERE business_date='2026-08-29'").get() as any).n, 2)
})

test('官方汇总与中心明细差异超过可确认上限时阻断且不修改快照', () => {
  const blocked = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-30T09:00:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 99,
    rows: rawRows(8),
  }, 'tester')

  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.publishable, false)
  assert.match(blocked.validationErrors.join('\n'), /官方汇总.*中心明细.*差异.*超过可确认上限/)
  assert.throws(() => reconciliation.publishDailyReconciliation(db, blocked.id, 'tester', '确认阻断批次不可发布'), /不可发布/)
  const snapshot = db.prepare(`SELECT daily_collection,cumulative_budget,cumulative_executed
    FROM daily_snapshots WHERE date='2026-08-29' AND center=?`).get(center) as any
  assert.deepEqual(snapshot, { daily_collection: 12.34, cumulative_budget: 160, cumulative_executed: 128.18 })
})

test('业务日未早于提取日时阻断', () => {
  const blocked = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-29T23:59:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 12.34,
    rows: rawRows(12.34),
  }, 'tester')
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.validationErrors.join('\n'), /业务日必须早于提取日/)
})

test('存在未验证快照时预览失败关闭', () => {
  const invalidCenter = canonicalCenters[1]
  db.prepare("UPDATE daily_snapshots SET quality_status='pending' WHERE date='2026-08-29' AND center=?").run(invalidCenter)
  try {
    const blocked = reconciliation.previewDailyReconciliation(db, {
      schemaVersion: 1,
      businessDate: '2026-08-29',
      extractedAt: '2026-08-30T09:10:00+08:00',
      reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
      region: '华北地区',
      officialTotal: 13.1,
      rows: rawRows(13.1),
    }, 'tester')
    assert.equal(blocked.status, 'blocked')
    assert.match(blocked.validationErrors.join('\n'), /56条.*quality_status=verified/)
  } finally {
    db.prepare("UPDATE daily_snapshots SET quality_status='verified' WHERE date='2026-08-29' AND center=?").run(invalidCenter)
  }
})

test('存在来源不可用快照时预览失败关闭', () => {
  const invalidCenter = canonicalCenters[2]
  db.prepare("UPDATE daily_snapshots SET source_status='unavailable' WHERE date='2026-08-29' AND center=?").run(invalidCenter)
  try {
    const blocked = reconciliation.previewDailyReconciliation(db, {
      schemaVersion: 1,
      businessDate: '2026-08-29',
      extractedAt: '2026-08-30T09:20:00+08:00',
      reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
      region: '华北地区',
      officialTotal: 13.2,
      rows: rawRows(13.2),
    }, 'tester')
    assert.equal(blocked.status, 'blocked')
    assert.match(blocked.validationErrors.join('\n'), /56条.*source_status=available/)
  } finally {
    db.prepare("UPDATE daily_snapshots SET source_status='available' WHERE date='2026-08-29' AND center=?").run(invalidCenter)
  }
})

test('存在business_date与目标日期不一致快照时预览失败关闭', () => {
  const invalidCenter = canonicalCenters[3]
  db.prepare("UPDATE daily_snapshots SET business_date='2026-08-28' WHERE date='2026-08-29' AND center=?").run(invalidCenter)
  try {
    const blocked = reconciliation.previewDailyReconciliation(db, {
      schemaVersion: 1,
      businessDate: '2026-08-29',
      extractedAt: '2026-08-30T09:30:00+08:00',
      reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
      region: '华北地区',
      officialTotal: 13.3,
      rows: rawRows(13.3),
    }, 'tester')
    assert.equal(blocked.status, 'blocked')
    assert.match(blocked.validationErrors.join('\n'), /56条.*business_date.*目标业务日/)
  } finally {
    db.prepare("UPDATE daily_snapshots SET business_date='2026-08-29' WHERE date='2026-08-29' AND center=?").run(invalidCenter)
  }
})

test('发布事务重新验证正式快照质量来源和业务日', () => {
  const cases = [
    { field: 'quality_status', invalid: 'pending', valid: 'verified', message: /质量状态已变化/ },
    { field: 'source_status', invalid: 'unavailable', valid: 'available', message: /来源状态已变化/ },
    { field: 'business_date', invalid: '2026-08-28', valid: '2026-08-29', message: /业务日已变化/ },
  ] as const
  cases.forEach((entry, index) => {
    const daily = 13.4 + index / 10
    const preview = reconciliation.previewDailyReconciliation(db, {
      schemaVersion: 1,
      businessDate: '2026-08-29',
      extractedAt: `2026-08-30T09:${40 + index}:00+08:00`,
      reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
      region: '华北地区',
      officialTotal: daily,
      rows: rawRows(daily),
    }, 'tester')
    db.prepare(`UPDATE daily_snapshots SET ${entry.field}=? WHERE date='2026-08-29' AND center=?`).run(entry.invalid, canonicalCenters[4])
    try {
      assert.throws(
        () => reconciliation.publishDailyReconciliation(db, preview.id, 'tester', '正式快照元数据变化不得发布'),
        entry.message,
      )
    } finally {
      db.prepare(`UPDATE daily_snapshots SET ${entry.field}=? WHERE date='2026-08-29' AND center=?`).run(entry.valid, canonicalCenters[4])
    }
  })
})

test('并发预览保持乐观锁且发布事务建立最新supersedes链', () => {
  const priorHead = db.prepare(`SELECT current.id FROM daily_collection_reconciliations current
    WHERE current.business_date='2026-08-29' AND current.status='published'
      AND NOT EXISTS(SELECT 1 FROM daily_collection_reconciliations successor
        WHERE successor.supersedes_id=current.id AND successor.status='published')`).get() as any
  const firstPreview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-30T10:00:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 13,
    rows: rawRows(13),
  }, 'tester')
  const secondPreview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-30T10:01:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 14,
    rows: rawRows(14),
  }, 'tester')
  const previewLinks = db.prepare('SELECT id,supersedes_id FROM daily_collection_reconciliations WHERE id IN (?,?) ORDER BY id').all(firstPreview.id, secondPreview.id) as any[]
  assert.deepEqual(previewLinks, [
    { id: firstPreview.id, supersedes_id: priorHead.id },
    { id: secondPreview.id, supersedes_id: priorHead.id },
  ])

  reconciliation.publishDailyReconciliation(db, firstPreview.id, 'tester', '首个并发预览确认发布')
  assert.throws(
    () => reconciliation.publishDailyReconciliation(db, secondPreview.id, 'tester', '陈旧并发预览不得发布'),
    /发布前(?:日报字段|验证元数据)已变化/,
  )

  const refreshed = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-30T10:01:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 14,
    rows: rawRows(14),
  }, 'tester')
  assert.notEqual(refreshed.id, secondPreview.id)
  assert.equal(refreshed.status, 'previewed')
  assert.equal((db.prepare('SELECT supersedes_id FROM daily_collection_reconciliations WHERE id=?').get(refreshed.id) as any).supersedes_id, firstPreview.id)
  reconciliation.publishDailyReconciliation(db, refreshed.id, 'tester', '基于最新快照重新预览后发布')

  const chain = db.prepare(`SELECT current.supersedes_id AS supersedesId,previous.status AS previousStatus,
    revision.old_daily_collection AS oldDaily,revision.new_daily_collection AS newDaily
    FROM daily_collection_reconciliations current
    JOIN daily_collection_reconciliations previous ON previous.id=current.supersedes_id
    JOIN daily_collection_revision_rows revision ON revision.reconciliation_id=current.id
    WHERE current.id=? AND revision.center=?`).get(refreshed.id, center) as any
  assert.deepEqual(chain, { supersedesId: firstPreview.id, previousStatus: 'published', oldDaily: 13, newDaily: 14 })
})

test('预览后的验证时间或字段血缘变化使发布乐观锁失败关闭', () => {
  const cases = [
    { field: 'last_validated_at', value: '2026-08-30T10:30:00+08:00' },
    { field: 'field_provenance', value: '{"daily_collection":{"source":"concurrent-writer"}}' },
  ] as const
  for (const [index, entry] of cases.entries()) {
    const preview = reconciliation.previewDailyReconciliation(db, {
      schemaVersion: 1,
      businessDate: '2026-08-29',
      extractedAt: `2026-08-30T10:${10 + index}:00+08:00`,
      reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
      region: '华北地区',
      officialTotal: 20 + index,
      rows: rawRows(20 + index),
    }, 'tester')
    const before = db.prepare(`SELECT ${entry.field} AS value FROM daily_snapshots WHERE date='2026-08-29' AND center=?`).get(canonicalCenters[6]) as any
    db.prepare(`UPDATE daily_snapshots SET ${entry.field}=? WHERE date='2026-08-29' AND center=?`).run(entry.value, canonicalCenters[6])
    try {
      assert.throws(
        () => reconciliation.publishDailyReconciliation(db, preview.id, 'tester', '并发元数据变化不得发布'),
        /发布前验证元数据已变化/,
      )
    } finally {
      db.prepare(`UPDATE daily_snapshots SET ${entry.field}=? WHERE date='2026-08-29' AND center=?`).run(before.value, canonicalCenters[6])
    }
  }
})

test('当前正式复核按supersedes链头识别而不是按预览ID大小识别', () => {
  const lowerIdPreview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-30T10:02:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 15,
    rows: rawRows(15),
  }, 'tester')
  const higherIdPreview = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-30T10:03:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 16,
    rows: rawRows(16),
  }, 'tester')
  assert.ok(lowerIdPreview.id < higherIdPreview.id)

  reconciliation.publishDailyReconciliation(db, higherIdPreview.id, 'tester', '先发布较高预览编号')
  const refreshedLower = reconciliation.previewDailyReconciliation(db, {
    schemaVersion: 1,
    businessDate: '2026-08-29',
    extractedAt: '2026-08-30T10:02:00+08:00',
    reportId: '810ca5a0-b239-466b-85c2-386373244c8e',
    region: '华北地区',
    officialTotal: 15,
    rows: rawRows(15),
  }, 'tester')
  reconciliation.publishDailyReconciliation(db, refreshedLower.id, 'tester', '后发布较低预览编号')

  const head = db.prepare('SELECT supersedes_id FROM daily_collection_reconciliations WHERE id=?').get(refreshedLower.id) as any
  assert.equal(head.supersedes_id, higherIdPreview.id)
  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), true)
})

test('当前正式复核在快照元数据发布后降级时立即失败关闭', () => {
  const cases = [
    { field: 'quality_status', invalid: 'pending', valid: 'verified' },
    { field: 'source_status', invalid: 'unavailable', valid: 'available' },
    { field: 'business_date', invalid: '2026-08-28', valid: '2026-08-29' },
  ] as const
  for (const entry of cases) {
    db.prepare(`UPDATE daily_snapshots SET ${entry.field}=? WHERE date='2026-08-29' AND center=?`).run(entry.invalid, canonicalCenters[5])
    try {
      assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), false)
    } finally {
      db.prepare(`UPDATE daily_snapshots SET ${entry.field}=? WHERE date='2026-08-29' AND center=?`).run(entry.valid, canonicalCenters[5])
    }
    assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), true)
  }
})

test('当前正式复核在保留的累计业务值发布后变化时立即失败关闭', () => {
  for (const field of ['cumulative_budget', 'cumulative_executed'] as const) {
    const row = db.prepare(`SELECT ${field} AS value FROM daily_snapshots WHERE date='2026-08-29' AND center=?`).get(canonicalCenters[5]) as { value: number }
    db.prepare(`UPDATE daily_snapshots SET ${field}=? WHERE date='2026-08-29' AND center=?`).run(row.value + 1, canonicalCenters[5])
    try {
      assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), false)
    } finally {
      db.prepare(`UPDATE daily_snapshots SET ${field}=? WHERE date='2026-08-29' AND center=?`).run(row.value, canonicalCenters[5])
    }
    assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), true)
  }
})

test('当前正式复核在发布验证时间或日报字段血缘损坏时立即失败关闭', () => {
  const center = canonicalCenters[5]
  const original = db.prepare(`SELECT last_validated_at,field_provenance FROM daily_snapshots WHERE date='2026-08-29' AND center=?`).get(center) as { last_validated_at: string; field_provenance: string }
  const mutations = [
    { field: 'last_validated_at', value: '2026-08-30T11:59:00+08:00' },
    { field: 'field_provenance', value: JSON.stringify({ daily_collection: { reportId: 'wrong-report' } }) },
  ] as const
  for (const mutation of mutations) {
    db.prepare(`UPDATE daily_snapshots SET ${mutation.field}=? WHERE date='2026-08-29' AND center=?`).run(mutation.value, center)
    try {
      assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), false)
    } finally {
      db.prepare(`UPDATE daily_snapshots SET ${mutation.field}=? WHERE date='2026-08-29' AND center=?`).run(original[mutation.field], center)
    }
    assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), true)
  }
})

test('已发布日报之外存在第57条当前快照时当前门禁失败', () => {
  db.prepare(`INSERT INTO daily_snapshots
    (date,center,business_date,annual_budget,cumulative_budget,cumulative_executed,daily_collection,
     quality_status,quality_reason,source,source_status,last_validated_at,field_provenance)
    VALUES('2026-08-29','第一服务额外服务中心','2026-08-29',1,1,1,0,
     'verified','测试额外快照','test','available','2026-08-30T10:00:00+08:00','{}')`).run()

  assert.equal(reconciliation.hasCurrentPublishedDailyReconciliation(db, '2026-08-29'), false)
})
