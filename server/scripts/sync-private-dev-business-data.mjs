import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { inspectReportArchiveBindings, rebuildPublishedMonthlyTrends } from './private-sync-derivations.mjs'

const productionDatabase = process.env.PRODUCTION_DB_PATH || '/home/ubuntu/cockpit/cockpit.db'
const developmentDatabase = process.env.DEVELOPMENT_DB_PATH || '/home/ubuntu/cockpit-dev/runtime/cockpit-dev.db'
const productionRoot = process.env.PRODUCTION_DATA_ROOT || '/home/ubuntu/cockpit'
const developmentRoot = process.env.DEVELOPMENT_DATA_ROOT || '/home/ubuntu/cockpit-dev/runtime'
const backupRoot = process.env.DEVELOPMENT_BACKUP_ROOT || path.join(developmentRoot, 'readonly-sync-backups')
const statusPath = process.env.DEVELOPMENT_SYNC_STATUS_PATH || path.join(developmentRoot, 'readonly-sync-status.json')

// 只镜像已经进入正式来源链的经营事实；账号、权限、日志、项目开发数据和欠费操作批次均保留在开发库。
const sourceTables = [
  'payment_centers',
  'daily_snapshots',
  'collection_centers',
  'historical_collections',
  'monthly_collections',
  'yearly_collections',
  'data_ingestion_batches',
  'data_ingestion_rows',
  'data_ingestion_publications',
  'data_sources',
  'data_source_sync_runs',
]

const sourceFiles = [
  'APH决策_每日提取.json',
  '绿仔收缴明细.json',
  '绿仔收款汇总.json',
  '绿仔同步状态.json',
]

function assertSafePaths() {
  for (const value of [productionDatabase, developmentDatabase, productionRoot, developmentRoot, backupRoot, statusPath]) {
    if (!path.isAbsolute(value)) throw new Error(`同步路径必须是绝对路径：${value}`)
  }
  if (path.resolve(productionDatabase) === path.resolve(developmentDatabase)) throw new Error('生产库和开发库不能是同一路径')
  if (path.resolve(productionRoot) === path.resolve(developmentRoot)) throw new Error('生产数据目录和开发数据目录不能是同一路径')
}

function quotedIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).all().map(column => String(column.name))
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function writeStatus(payload) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true })
  const temporary = `${statusPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, statusPath)
}

function testFailureAfterFileReplacements() {
  if (process.env.NODE_ENV !== 'test') return null
  const raw = String(process.env.PRIVATE_SYNC_TEST_FAIL_AFTER_FILE_REPLACEMENTS || '').trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > sourceFiles.length) {
    throw new Error('测试故障注入的文件序号无效')
  }
  return value
}

function restoreDestinationFiles(filePlans) {
  const failures = []
  for (const plan of filePlans) {
    try {
      if (plan.existed) {
        const candidate = `${plan.destination}.rollback.${process.pid}.${Date.now()}`
        fs.copyFileSync(plan.backup, candidate)
        fs.renameSync(candidate, plan.destination)
        if (sha256(plan.destination) !== plan.beforeSha256) throw new Error('恢复后SHA256不一致')
      } else if (fs.existsSync(plan.destination)) {
        fs.unlinkSync(plan.destination)
      }
    } catch (error) {
      failures.push(`${plan.name}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length) throw new Error(`同步失败后的来源文件恢复不完整：${failures.join('；')}`)
}

async function main() {
  assertSafePaths()
  const startedAt = new Date().toISOString()
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const backupDirectory = path.join(backupRoot, stamp)
  const stageDirectory = path.join(developmentRoot, `.readonly-sync-stage-${process.pid}-${Date.now()}`)
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 })
  fs.mkdirSync(stageDirectory, { recursive: true, mode: 0o700 })

  const production = new Database(productionDatabase, { readonly: true, fileMustExist: true })
  const development = new Database(developmentDatabase, { fileMustExist: true })
  try {
    if (production.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('生产数据库完整性检查失败')
    if (development.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('开发数据库完整性检查失败')

    await development.backup(path.join(backupDirectory, 'cockpit-dev.before.db'))
    fs.chmodSync(path.join(backupDirectory, 'cockpit-dev.before.db'), 0o600)

    const stagedFiles = sourceFiles.map(name => {
      const source = path.join(productionRoot, name)
      const staged = path.join(stageDirectory, name)
      if (!fs.existsSync(source)) throw new Error(`缺少生产来源文件：${name}`)
      fs.copyFileSync(source, staged)
      JSON.parse(fs.readFileSync(staged, 'utf8'))
      return { name, staged, sha256: sha256(staged) }
    })

    const snapshots = new Map()
    production.exec('BEGIN')
    try {
      for (const table of sourceTables) {
        const productionColumns = tableColumns(production, table)
        const developmentColumns = tableColumns(development, table)
        if (!productionColumns.length || productionColumns.join('\0') !== developmentColumns.join('\0')) {
          throw new Error(`表结构不一致：${table}`)
        }
        snapshots.set(table, {
          columns: productionColumns,
          rows: production.prepare(`SELECT * FROM ${quotedIdentifier(table)}`).all(),
        })
      }
      production.exec('COMMIT')
    } catch (error) {
      production.exec('ROLLBACK')
      throw error
    }

    // 在任何目标替换前完整保存四个旧入口；恢复时按旧SHA逐个复验。
    const filePlans = stagedFiles.map(item => {
      const destination = path.join(developmentRoot, item.name)
      const existed = fs.existsSync(destination)
      const backup = path.join(backupDirectory, item.name)
      if (existed) fs.copyFileSync(destination, backup)
      return {
        ...item,
        destination,
        existed,
        backup,
        beforeSha256: existed ? sha256(backup) : null,
      }
    })
    const failAfterFile = testFailureAfterFileReplacements()

    development.pragma('foreign_keys = OFF')
    let trendRebuild
    let archiveIntegrity
    try {
      const replaceFactsAndFiles = development.transaction(() => {
        for (const table of [...sourceTables].reverse()) {
          development.prepare(`DELETE FROM ${quotedIdentifier(table)}`).run()
        }
        for (const table of sourceTables) {
          const snapshot = snapshots.get(table)
          const columns = snapshot.columns.map(quotedIdentifier).join(',')
          const placeholders = snapshot.columns.map(() => '?').join(',')
          const insert = development.prepare(`INSERT INTO ${quotedIdentifier(table)} (${columns}) VALUES (${placeholders})`)
          for (const row of snapshot.rows) insert.run(...snapshot.columns.map(column => row[column]))
        }
        // monthly_trends 是正式P46事实的派生物，不直接镜像旧结果；与事实替换同事务重建，
        // 保证任一失败时整次同步回滚，也避免同月继续绑定过时批次。
        trendRebuild = rebuildPublishedMonthlyTrends(development)
        if (development.pragma('foreign_key_check').length) throw new Error('开发数据库外键检查失败')
        if (development.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('同步后开发数据库完整性检查失败')
        archiveIntegrity = inspectReportArchiveBindings(development)

        // 文件替换仍在SQLite事务提交之前；任一rename或SHA后验失败会先回滚DB，外层再恢复文件。
        let replaced = 0
        for (const plan of filePlans) {
          fs.renameSync(plan.staged, plan.destination)
          replaced += 1
          if (sha256(plan.destination) !== plan.sha256) throw new Error(`来源文件替换后SHA256不一致：${plan.name}`)
          if (failAfterFile === replaced) throw new Error(`测试故障注入：第${replaced}个来源文件替换后失败`)
        }
      })
      replaceFactsAndFiles.immediate()
    } catch (error) {
      try { restoreDestinationFiles(filePlans) }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], '私有事实同步失败且文件恢复不完整')
      }
      throw error
    } finally {
      development.pragma('foreign_keys = ON')
    }

    const completedAt = new Date().toISOString()
    const tables = Object.fromEntries(sourceTables.map(table => [table, snapshots.get(table).rows.length]))
    writeStatus({
      ok: true,
      mode: 'production-readonly-to-private-development',
      startedAt,
      completedAt,
      productionDatabase,
      developmentDatabase,
      backupDirectory,
      tables,
      trendRebuild,
      archiveIntegrity,
      files: Object.fromEntries(stagedFiles.map(item => [item.name, item.sha256])),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, completedAt, backupDirectory, tables, trendRebuild, archiveIntegrity })}\n`)
  } catch (error) {
    writeStatus({ ok: false, mode: 'production-readonly-to-private-development', startedAt, failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    development.close()
    production.close()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
