#!/usr/bin/env node
import { northChinaBusinessDate, publicationConfirmed } from './lvzai-arrears-job.js'
import { loadWecomLedgerScopeConfig, runWecomLedgerJob } from './wecom-ledger-job.js'
import { WecomLedgerProcessTransport } from './wecom-ledger-process-transport.js'

function argumentsFrom(argv: string[]): { publish: boolean; businessDate?: string } {
  let publish = false, businessDate: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--publish') publish = true
    else if (argument === '--dry-run') publish = false
    else if (argument === '--business-date') { businessDate = argv[++index]; if (!businessDate) throw new Error('--business-date缺少日期') }
    else throw new Error(`不支持的参数：${argument}`)
  }
  return { publish, businessDate }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2))
  const configPath = String(process.env.WECOM_LEDGER_SCOPE_FILE || '').trim()
  const extractorPath = String(process.env.WECOM_LEDGER_EXTRACTOR || '').trim()
  if (!configPath) throw new Error('缺少WECOM_LEDGER_SCOPE_FILE')
  if (!extractorPath) throw new Error('缺少WECOM_LEDGER_EXTRACTOR')
  const businessDate = args.businessDate || northChinaBusinessDate()
  if (args.publish && !publicationConfirmed(businessDate, process.env.ARREARS_WECOM_PUBLISH_CONFIRM, process.env.NODE_ENV)) throw new Error('企业微信台账正式发布缺少生产环境与业务日期双重确认')
  const config = loadWecomLedgerScopeConfig(configPath)
  const transport = new WecomLedgerProcessTransport({ executablePath: extractorPath })
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try {
    const database = args.publish ? (await import('./db.js')).default : undefined
    const result = await runWecomLedgerJob({ config, transport, businessDate, publish: args.publish, publishConfirmation: process.env.ARREARS_WECOM_PUBLISH_CONFIRM, nodeEnv: process.env.NODE_ENV, database, signal: controller.signal })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'WECOM_LEDGER_JOB_FAILED', message: error instanceof Error ? error.message : '企业微信台账任务失败' })}\n`)
  process.exitCode = 1
})
