import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import Database from 'better-sqlite3'

const date = process.env.P46_DATE
const note = String(process.env.P46_NOTE || '').trim()
const cockpitRoot = process.env.COCKPIT_ROOT || '/home/ubuntu/cockpit'
const databasePath = process.env.COCKPIT_DB_PATH || path.join(cockpitRoot, 'cockpit.db')

if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('P46_DATE required')
if (note.length < 5) throw new Error('P46_NOTE must contain at least 5 characters')

function envFile(file) {
  const output = {}
  if (!fs.existsSync(file)) return output
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (match) output[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return output
}

const env = { ...envFile('/etc/first-service/cockpit.env'), ...process.env }
let secret = env.JWT_SECRET || ''
for (const file of [env.JWT_SECRET_FILE, `${os.homedir()}/.cockpit_jwt_secret`, '/home/ubuntu/.cockpit_jwt_secret']) {
  if (!secret && file && fs.existsSync(file)) secret = fs.readFileSync(file, 'utf8').trim()
}
if (secret.length < 32) throw new Error('JWT secret missing')

const database = new Database(databasePath, { readonly: true })
const user = database.prepare("SELECT id,username,role,coalesce(area_scope,'') areaScope,coalesce(project_scope,'') projectScope,coalesce(service_center_scope,'') serviceCenterScope,coalesce(token_version,0) tokenVersion FROM users WHERE role='admin' ORDER BY id LIMIT 1").get()
const batch = database.prepare('SELECT id,status,publishable,business_date FROM data_ingestion_batches WHERE business_date=? ORDER BY id DESC LIMIT 1').get(date)
database.close()

if (!user) throw new Error('admin missing')
if (!batch) throw new Error(`no P46 batch for ${date}`)
if (batch.status !== 'published' && (batch.status !== 'previewed' || !batch.publishable)) {
  throw new Error(`batch ${batch.id} is not publishable: status=${batch.status}`)
}

// 无论首次发布还是幂等复核，都只调用生产 API；固定入口与 V2 回执由同一事务维护。
const token = jwt.sign({
  userId: user.id,
  username: user.username,
  role: user.role,
  areaScope: user.areaScope,
  projectScope: user.projectScope,
  serviceCenterScope: user.serviceCenterScope,
  tokenVersion: user.tokenVersion,
}, secret, { expiresIn: '5m' })

const response = await fetch(`http://127.0.0.1:3002/api/data-pipeline/batches/${batch.id}/publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ confirmNote: note }),
})
const payload = await response.json()
if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)

const verificationDatabase = new Database(databasePath, { readonly: true })
const publishedBatch = verificationDatabase.prepare(`SELECT b.id,b.status,b.business_date,b.batch_sha256,b.source_files,
  b.published_by,b.published_at,
  (SELECT COUNT(*) FROM data_ingestion_publications p
    WHERE p.batch_id=b.id AND p.business_date=b.business_date
      AND length(p.backup_sha256)=64 AND p.payment_rows>0 AND p.collection_rows=35) formal_publication_count
  FROM data_ingestion_batches b WHERE b.id=?`).get(batch.id)
verificationDatabase.close()
if (!publishedBatch || publishedBatch.status !== 'published') throw new Error('正式发布后未读取到 published 批次')
if (publishedBatch.formal_publication_count !== 1) throw new Error('正式发布回执缺失或不唯一')

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function collectionContentSha256(detailContent, summaryContent) {
  return crypto.createHash('sha256')
    .update('first-service-live-collection-v1\0detail\0', 'utf8')
    .update(detailContent)
    .update('\0summary\0', 'utf8')
    .update(summaryContent)
    .digest('hex')
}

function verifyFixedEntries(currentBatch) {
  const detailContent = fs.readFileSync(path.join(cockpitRoot, '绿仔收缴明细.json'))
  const summaryContent = fs.readFileSync(path.join(cockpitRoot, '绿仔收款汇总.json'))
  const receiptContent = fs.readFileSync(path.join(cockpitRoot, '绿仔同步状态.json'))
  const detail = JSON.parse(detailContent.toString('utf8'))
  const summary = JSON.parse(summaryContent.toString('utf8'))
  const receipt = JSON.parse(receiptContent.toString('utf8'))
  if (detail.businessDate !== date || detail.date !== date || summary.date !== date || !Array.isArray(detail.rows) || detail.rows.length !== 35) {
    throw new Error('生产 API 写入的收缴固定入口日期或35中心范围不合格')
  }
  if (receipt.batchId !== `p46-${currentBatch.id}` || receipt.p46BatchSha256 !== String(currentBatch.batch_sha256 || '').toLowerCase()) {
    throw new Error('生产 API 写入的发布回执未绑定当前P46批次')
  }
  if (receipt.collectionContentSha256 !== collectionContentSha256(detailContent, summaryContent)) {
    throw new Error('生产 API 写入的发布回执与固定入口原文字节不一致')
  }
  return { detailRows: detail.rows.length, receiptSha256: sha256(receiptContent) }
}

const fixedEntries = verifyFixedEntries(publishedBatch)

console.log(JSON.stringify({
  ok: true,
  idempotent: Boolean(payload.idempotent),
  id: publishedBatch.id,
  status: publishedBatch.status,
  businessDate: publishedBatch.business_date,
  publishedAt: publishedBatch.published_at,
  fixedEntries,
}))
