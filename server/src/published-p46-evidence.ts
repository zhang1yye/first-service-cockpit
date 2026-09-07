import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { parseStrictUtf8Json } from './collection-quality.js'
import type { NormalizedBundle } from './data-pipeline.js'
import { formalP46PublicationPredicate } from './formal-p46-publication.js'

type PublishedBatchRow = {
  id: number
  business_date: string
  batch_sha256: string
  source_files: string
  archive_dir: string
  summary: string
  payment_rows: number
  snapshot_rows: number
  collection_rows: number
}

export type PublishedP46Evidence = {
  batchId: number
  businessDate: string
  bundle: NormalizedBundle
  summary: Record<string, any>
}

function sha256(value: Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

const requiredArchiveKeys = ['aph', 'paymentDetail', 'lvzai', 'collectionDetail', 'collectionSummary', 'normalized'] as const

function safeArchiveName(key: string, name: string) {
  return `${key}-${path.basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')}`
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

export function loadPublishedP46Evidence(
  database: Database.Database,
  selector: { batchId?: number; businessDate?: string; beforeDate?: string },
): PublishedP46Evidence | null {
  const selectors = [selector.batchId != null, Boolean(selector.businessDate), Boolean(selector.beforeDate)].filter(Boolean).length
  if (selectors !== 1) {
    throw new Error('正式P46证据查询必须且只能指定batchId、businessDate或beforeDate之一')
  }
  const formalPublication = formalP46PublicationPredicate('batch')
  const condition = selector.batchId != null
    ? 'batch.id=?'
    : selector.businessDate ? 'batch.business_date=?' : 'batch.business_date<?'
  const value = selector.batchId ?? selector.businessDate ?? selector.beforeDate
  const batch = database.prepare(`SELECT batch.id,batch.business_date,batch.batch_sha256,batch.source_files,batch.archive_dir,batch.summary,
      publication.payment_rows,publication.snapshot_rows,publication.collection_rows
    FROM data_ingestion_batches batch
    JOIN data_ingestion_publications publication ON publication.batch_id=batch.id
    WHERE ${condition} AND batch.status='published'
      AND length(batch.batch_sha256)=64 AND COALESCE(batch.published_at,'')<>''
      AND ${formalPublication}
    ORDER BY batch.business_date DESC,datetime(batch.published_at) DESC,batch.id DESC
    LIMIT 1`).get(value) as PublishedBatchRow | undefined
  if (!batch) return null

  let sourceFiles: any[]
  let summary: Record<string, any>
  try {
    sourceFiles = JSON.parse(batch.source_files || '[]')
    summary = JSON.parse(batch.summary || '{}')
  } catch {
    throw new Error(`正式P46批次${batch.id}的来源或摘要JSON无效`)
  }
  const archiveRoot = path.resolve(String(batch.archive_dir || ''))
  const configuredArchiveRoot = path.resolve(process.env.COCKPIT_RAW_ARCHIVE_DIR || path.join(process.cwd(), 'data', 'raw'))
  const configuredArchiveStat = fs.lstatSync(configuredArchiveRoot)
  if (!configuredArchiveStat.isDirectory() || configuredArchiveStat.isSymbolicLink()) {
    throw new Error('P46配置归档根不是受控实体目录')
  }
  const realConfiguredArchiveRoot = fs.realpathSync.native(configuredArchiveRoot)
  const expectedDateDirectory = path.resolve(configuredArchiveRoot, batch.business_date)
  if (path.basename(path.dirname(archiveRoot)) !== batch.business_date
    || path.basename(archiveRoot) !== String(batch.batch_sha256).slice(0, 16)) {
    throw new Error(`正式P46批次${batch.id}的归档目录与业务日期或批次SHA不一致`)
  }
  const dateDirectory = path.dirname(archiveRoot)
  if (dateDirectory !== expectedDateDirectory) throw new Error(`正式P46批次${batch.id}的归档目录越出配置归档根`)
  const dateDirectoryStat = fs.lstatSync(dateDirectory)
  const archiveStat = fs.lstatSync(archiveRoot)
  if (!dateDirectoryStat.isDirectory() || dateDirectoryStat.isSymbolicLink()
    || !archiveStat.isDirectory() || archiveStat.isSymbolicLink()) {
    throw new Error(`正式P46批次${batch.id}的归档目录包含符号链接或真实路径越界`)
  }
  if (fs.realpathSync.native(dateDirectory) !== path.join(realConfiguredArchiveRoot, batch.business_date)) {
    throw new Error(`正式P46批次${batch.id}的业务日归档真实路径越出配置归档根`)
  }
  const realArchiveRoot = fs.realpathSync.native(archiveRoot)
  const keyCounts = new Map<string, number>()
  for (const file of sourceFiles) keyCounts.set(String(file?.key || ''), (keyCounts.get(String(file?.key || '')) || 0) + 1)
  const invalidKeys = sourceFiles.length !== requiredArchiveKeys.length
    || requiredArchiveKeys.some(key => keyCounts.get(key) !== 1)
    || [...keyCounts.keys()].some(key => !requiredArchiveKeys.includes(key as typeof requiredArchiveKeys[number]))
  if (invalidKeys) throw new Error(`正式P46批次${batch.id}的六源归档键集合无效`)

  const verified = new Map<string, Buffer>()
  const verifiedHashes: Array<{ key: string; sha256: string }> = []
  for (const file of sourceFiles) {
    const key = String(file.key || '')
    const name = String(file.name || '')
    const candidate = path.resolve(String(file.path || ''))
    const expected = path.resolve(archiveRoot, safeArchiveName(key, name))
    if (!name || candidate !== expected || !inside(archiveRoot, candidate)) {
      throw new Error(`正式P46批次${batch.id}的源文件${key || 'unknown'}归档路径越界或不确定`)
    }
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(candidate)
    } catch {
      throw new Error(`正式P46批次${batch.id}的源文件${key}归档不存在`)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`正式P46批次${batch.id}的源文件${key}归档不是常规文件`)
    if (fs.realpathSync.native(candidate) !== path.join(realArchiveRoot, path.basename(expected))) {
      throw new Error(`正式P46批次${batch.id}的源文件${key}归档真实路径越界`)
    }
    const bytes = fs.readFileSync(candidate)
    if (!Number.isSafeInteger(file.size) || bytes.length !== Number(file.size)) {
      throw new Error(`正式P46批次${batch.id}的源文件${key}归档大小已变化`)
    }
    const claimedSha = String(file.sha256 || '')
    if (!/^[a-f0-9]{64}$/.test(claimedSha) || sha256(bytes) !== claimedSha) {
      throw new Error(`正式P46批次${batch.id}的源文件${key}归档SHA已变化`)
    }
    verified.set(key, bytes)
    verifiedHashes.push({ key, sha256: claimedSha })
  }
  const recomputedBatchSha = sha256(Buffer.from(verifiedHashes
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(file => file.sha256)
    .join(':')))
  if (!/^[a-f0-9]{64}$/.test(String(batch.batch_sha256 || '')) || recomputedBatchSha !== batch.batch_sha256) {
    throw new Error(`正式P46批次${batch.id}的六源批次SHA已变化`)
  }
  const bundle = parseStrictUtf8Json(verified.get('normalized')!, `正式P46批次${batch.id}规范化归档`) as NormalizedBundle
  if (bundle.schema_version !== 2 || bundle.business_date !== batch.business_date) {
    throw new Error(`正式P46批次${batch.id}的规范化归档版本或业务日期不一致`)
  }
  if (!Array.isArray(bundle.payment_centers) || bundle.payment_centers.length !== Number(batch.payment_rows)
    || !Array.isArray(bundle.daily_snapshots) || bundle.daily_snapshots.length !== Number(batch.snapshot_rows)
    || !Array.isArray(bundle.collection_centers) || bundle.collection_centers.length !== Number(batch.collection_rows)) {
    throw new Error(`正式P46批次${batch.id}的规范化归档行数与发布回执不一致`)
  }
  if (bundle.daily_snapshots.some(row => row.date !== batch.business_date || row.business_date !== batch.business_date)) {
    throw new Error(`正式P46批次${batch.id}的规范化日报业务日期不一致`)
  }
  return { batchId: batch.id, businessDate: batch.business_date, bundle, summary }
}
