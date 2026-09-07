#!/usr/bin/env node
import fs from 'node:fs'
import { northChinaBusinessDate, publicationConfirmed } from './lvzai-arrears-job.js'
import { initialQxmCursorState, loadQxmCursorState, loadQxmEvidenceScopeConfig, runQxmEvidenceShardedJob, saveQxmCursorState } from './qxm-evidence-job.js'
import { QxmEvidenceProcessTransport } from './qxm-evidence-process-transport.js'

function argumentsFrom(argv: string[]): { publish: boolean; initializeCursors: boolean; businessDate?: string } {
  let publish = false, initializeCursors = false, businessDate: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--publish') publish = true
    else if (argument === '--dry-run') publish = false
    else if (argument === '--initialize-cursors') initializeCursors = true
    else if (argument === '--business-date') { businessDate = argv[++index]; if (!businessDate) throw new Error('--business-date缺少日期') }
    else throw new Error(`不支持的参数：${argument}`)
  }
  if (initializeCursors && (publish || businessDate)) throw new Error('初始化游标不得与发布或业务日期参数组合')
  return { publish, initializeCursors, businessDate }
}
async function main() {
  const args = argumentsFrom(process.argv.slice(2))
  const configPath = String(process.env.QXM_EVIDENCE_SCOPE_FILE || '').trim()
  const statePath = String(process.env.QXM_CURSOR_STATE_FILE || '').trim()
  if (!configPath) throw new Error('缺少QXM_EVIDENCE_SCOPE_FILE')
  if (!statePath) throw new Error('缺少QXM_CURSOR_STATE_FILE')
  const config = loadQxmEvidenceScopeConfig(configPath)
  if (args.initializeCursors) {
    if (fs.existsSync(statePath)) throw new Error('企小码游标状态文件已存在，拒绝覆盖初始化')
    saveQxmCursorState(statePath, initialQxmCursorState(config), config)
    process.stdout.write(`${JSON.stringify({ mode: 'cursor-initialized', source: 'qxm', departmentScopeCount: config.departments.length })}\n`)
    return
  }
  const extractorPath = String(process.env.QXM_EVIDENCE_EXTRACTOR || '').trim()
  if (!extractorPath) throw new Error('缺少QXM_EVIDENCE_EXTRACTOR')
  const businessDate = args.businessDate || northChinaBusinessDate()
  if (args.publish && !publicationConfirmed(businessDate, process.env.ARREARS_QXM_PUBLISH_CONFIRM, process.env.NODE_ENV)) throw new Error('企小码证据正式发布缺少生产环境与业务日期双重确认')
  const cursorState = loadQxmCursorState(statePath, config)
  const transport = new QxmEvidenceProcessTransport({ executablePath: extractorPath, timeoutMs: 1_800_000 })
  const controller = new AbortController(), abort = () => controller.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try {
    const database = args.publish ? (await import('./db.js')).default : undefined
    const result = await runQxmEvidenceShardedJob({ config, cursorState, cursorStatePath: statePath, transport, businessDate, publish: args.publish, publishConfirmation: process.env.ARREARS_QXM_PUBLISH_CONFIRM, nodeEnv: process.env.NODE_ENV, database, signal: controller.signal })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
}
main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'QXM_EVIDENCE_JOB_FAILED', message: error instanceof Error ? error.message : '企小码证据任务失败' })}\n`)
  process.exitCode = 1
})
