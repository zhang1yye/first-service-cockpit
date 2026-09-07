import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import test from 'node:test'
import { loadPublishedP46Evidence } from '../src/published-p46-evidence.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'published-p46-evidence-'))
  process.env.COCKPIT_RAW_ARCHIVE_DIR = root
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE data_ingestion_batches(
      id INTEGER PRIMARY KEY,business_date TEXT,status TEXT,batch_sha256 TEXT,published_at TEXT,
      source_files TEXT,archive_dir TEXT,summary TEXT
    );
    CREATE TABLE data_ingestion_rows(
      id INTEGER PRIMARY KEY,batch_id INTEGER,entity_type TEXT,payload TEXT
    );
    CREATE TABLE data_ingestion_publications(
      batch_id INTEGER,business_date TEXT,backup_sha256 TEXT,published_at TEXT,
      payment_rows INTEGER,snapshot_rows INTEGER,collection_rows INTEGER
    );
  `)
  const paymentCenters = [{ area: '华北地区', center: '第一服务证据中心', annual_budget: 100, cumulative_budget: 80, cumulative_executed: 50, same_period: 40, collection_rate: 0.5 }]
  const dailySnapshots = [{ date: '2026-08-31', business_date: '2026-08-31', center: '第一服务证据中心', annual_budget: 100, cumulative_budget: 80, cumulative_executed: 50, daily_collection: 5, quality_status: 'verified', source_status: 'available', source: 'FineReport', last_validated_at: '2026-08-31T17:30:00+08:00', field_provenance: {} }]
  const collectionCenters = Array.from({ length: 35 }, (_, index) => ({ area: '华北地区', center: `收缴中心${index}`, receivable: 10, received: 5, collectionRate: 0.5 }))
  const bundle = { schema_version: 2, business_date: '2026-08-31', payment_centers: paymentCenters, daily_snapshots: dailySnapshots, collection_centers: collectionCenters }
  const normalized = Buffer.from(JSON.stringify(bundle))
  const sources = [
    { key: 'aph', name: 'aph.json', content: Buffer.from('{}') },
    { key: 'paymentDetail', name: 'payment-detail.json', content: Buffer.from('[]') },
    { key: 'lvzai', name: 'lvzai.json', content: Buffer.from('{}') },
    { key: 'collectionDetail', name: 'collection-detail.json', content: Buffer.from('[]') },
    { key: 'collectionSummary', name: 'collection-summary.json', content: Buffer.from('{}') },
    { key: 'normalized', name: 'normalized.json', content: normalized },
  ].map(file => ({ ...file, sha256: crypto.createHash('sha256').update(file.content).digest('hex') }))
  const batchSha256 = crypto.createHash('sha256')
    .update(sources.slice().sort((left, right) => left.key.localeCompare(right.key)).map(file => file.sha256).join(':'))
    .digest('hex')
  const archiveDir = path.join(root, '2026-08-31', batchSha256.slice(0, 16))
  fs.mkdirSync(archiveDir, { recursive: true })
  const sourceFiles = sources.map(file => {
    const filePath = path.join(archiveDir, `${file.key}-${file.name}`)
    fs.writeFileSync(filePath, file.content)
    return { key: file.key, name: file.name, path: filePath, size: file.content.length, sha256: file.sha256 }
  })
  const normalizedPath = sourceFiles.find(file => file.key === 'normalized')!.path
  const aphPath = sourceFiles.find(file => file.key === 'aph')!.path
  database.prepare(`INSERT INTO data_ingestion_batches
    (id,business_date,status,batch_sha256,published_at,source_files,archive_dir,summary)
    VALUES(1,'2026-08-31','published',?,'2026-08-31 17:31:00',?,?,?)`
  ).run(batchSha256, JSON.stringify(sourceFiles), archiveDir, JSON.stringify({ dailyReview: { status: 'pending_review' } }))
  const insertRow = database.prepare('INSERT INTO data_ingestion_rows(batch_id,entity_type,payload) VALUES(1,?,?)')
  insertRow.run('payment_center', JSON.stringify(paymentCenters[0]))
  insertRow.run('daily_snapshot', JSON.stringify(dailySnapshots[0]))
  for (const row of collectionCenters) insertRow.run('collection_center', JSON.stringify(row))
  database.prepare(`INSERT INTO data_ingestion_publications
    (batch_id,business_date,backup_sha256,published_at,payment_rows,snapshot_rows,collection_rows)
    VALUES(1,'2026-08-31',?,'2026-08-31 17:31:00',1,1,35)`
  ).run('b'.repeat(64))
  return { root, archiveDir, batchSha256, sourceFiles, normalizedPath, aphPath, database, bundle }
}

test('loads source values from the hash-bound normalized archive of the formal publication', () => {
  const value = fixture()
  try {
    const evidence = loadPublishedP46Evidence(value.database, { businessDate: '2026-08-31' })
    assert.ok(evidence)
    assert.equal(evidence.batchId, 1)
    assert.deepEqual(evidence.bundle.daily_snapshots, value.bundle.daily_snapshots)
    assert.equal(evidence.summary.dailyReview.status, 'pending_review')
  } finally {
    value.database.close()
    fs.rmSync(value.root, { recursive: true, force: true })
  }
})

test('fails closed when the published normalized archive is changed after publication', () => {
  const value = fixture()
  try {
    fs.appendFileSync(value.normalizedPath, '\n')
    assert.throws(
      () => loadPublishedP46Evidence(value.database, { businessDate: '2026-08-31' }),
      /归档.*大小|SHA/,
    )
  } finally {
    value.database.close()
    fs.rmSync(value.root, { recursive: true, force: true })
  }
})

test('fails closed when any non-normalized source archive is changed after publication', () => {
  const value = fixture()
  try {
    fs.appendFileSync(value.aphPath, '\n')
    assert.throws(
      () => loadPublishedP46Evidence(value.database, { businessDate: '2026-08-31' }),
      /归档.*大小|SHA|批次SHA/,
    )
  } finally {
    value.database.close()
    fs.rmSync(value.root, { recursive: true, force: true })
  }
})

test('fails closed when an intermediate archive directory is replaced by a symlink', () => {
  const value = fixture()
  try {
    const outside = path.join(value.root, 'outside')
    fs.renameSync(value.archiveDir, outside)
    fs.symlinkSync(outside, value.archiveDir, 'dir')
    assert.throws(
      () => loadPublishedP46Evidence(value.database, { businessDate: '2026-08-31' }),
      /符号链接|真实路径|越界/,
    )
  } finally {
    value.database.close()
    fs.rmSync(value.root, { recursive: true, force: true })
  }
})

test('fails closed when a valid-shaped archive is redirected outside the configured archive root', () => {
  const value = fixture()
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'published-p46-outside-'))
  try {
    const outsideArchive = path.join(outsideRoot, '2026-08-31', value.batchSha256.slice(0, 16))
    fs.mkdirSync(outsideArchive, { recursive: true })
    const redirected = value.sourceFiles.map(file => {
      const redirectedPath = path.join(outsideArchive, path.basename(file.path))
      fs.copyFileSync(file.path, redirectedPath)
      return { ...file, path: redirectedPath }
    })
    value.database.prepare('UPDATE data_ingestion_batches SET archive_dir=?,source_files=? WHERE id=1')
      .run(outsideArchive, JSON.stringify(redirected))
    assert.throws(
      () => loadPublishedP46Evidence(value.database, { businessDate: '2026-08-31' }),
      /配置归档根|归档根.*越界/,
    )
  } finally {
    value.database.close()
    fs.rmSync(value.root, { recursive: true, force: true })
    fs.rmSync(outsideRoot, { recursive: true, force: true })
  }
})
