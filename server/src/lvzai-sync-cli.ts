#!/usr/bin/env node
import { loadLvzaiArrearsScopeConfig, northChinaBusinessDate, publicationConfirmed, runLvzaiArrearsJob } from './lvzai-arrears-job.js'
import { LvzaiHttpTransport } from './lvzai-http-transport.js'

function argumentsFrom(argv: string[]): { publish: boolean; businessDate?: string } {
  let publish = false
  let businessDate: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--publish') publish = true
    else if (argument === '--dry-run') publish = false
    else if (argument === '--business-date') {
      businessDate = argv[index + 1]
      index += 1
      if (!businessDate) throw new Error('--business-date缺少日期')
    } else throw new Error(`不支持的参数：${argument}`)
  }
  return { publish, businessDate }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2))
  const configPath = String(process.env.LVZAI_ARREARS_SCOPE_FILE || '').trim()
  if (!configPath) throw new Error('缺少LVZAI_ARREARS_SCOPE_FILE')
  const config = loadLvzaiArrearsScopeConfig(configPath)
  const transport = new LvzaiHttpTransport({
    statePath: process.env.LVZAI_STATE_PATH,
    loginScript: process.env.LVZAI_LOGIN_SCRIPT,
  })
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const businessDate = args.businessDate || northChinaBusinessDate()
    if (args.publish && !publicationConfirmed(businessDate, process.env.ARREARS_LVZAI_PUBLISH_CONFIRM, process.env.NODE_ENV)) {
      throw new Error('绿仔欠费正式发布缺少生产环境与业务日期双重确认')
    }
    const database = args.publish ? (await import('./db.js')).default : undefined
    const result = await runLvzaiArrearsJob({
      config,
      transport,
      businessDate,
      publish: args.publish,
      publishConfirmation: process.env.ARREARS_LVZAI_PUBLISH_CONFIRM,
      nodeEnv: process.env.NODE_ENV,
      database,
      signal: controller.signal,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '绿仔逐户欠费任务失败'
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'LVZAI_ARREARS_JOB_FAILED', message })}\n`)
  process.exitCode = 1
})
