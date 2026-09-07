#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { northChinaBusinessDate } from './lvzai-arrears-job.js'
import { LvzaiHttpTransport } from './lvzai-http-transport.js'
import { discoverLvzaiArrearsScope } from './lvzai-scope-discovery.js'

function argumentsFrom(argv: string[]): { businessDate?: string; writePath?: string } {
  let businessDate: string | undefined
  let writePath: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--business-date') { businessDate = argv[++index]; if (!businessDate) throw new Error('--business-date缺少日期') }
    else if (argument === '--write') { writePath = argv[++index]; if (!writePath) throw new Error('--write缺少路径') }
    else throw new Error(`不支持的参数：${argument}`)
  }
  return { businessDate, writePath }
}

function writeConfig(filePath: string, config: object): void {
  const resolved = path.resolve(filePath)
  const parent = fs.lstatSync(path.dirname(resolved))
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('绿仔范围配置目标目录无效')
  if ((parent.mode & 0o022) !== 0) throw new Error('绿仔范围配置目标目录不得允许组或其他用户写入')
  if (typeof process.getuid === 'function' && parent.uid !== process.getuid()) throw new Error('绿仔范围配置目标目录不属于当前任务用户')
  const descriptor = fs.openSync(resolved, 'wx', 0o640)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.fchmodSync(descriptor, 0o640)
  } finally { fs.closeSync(descriptor) }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2))
  const businessDate = args.businessDate || northChinaBusinessDate()
  if (args.writePath && process.env.LVZAI_ARREARS_SCOPE_WRITE_CONFIRM !== businessDate) throw new Error('写入绿仔范围配置缺少业务日期确认')
  const transport = new LvzaiHttpTransport({ statePath: process.env.LVZAI_STATE_PATH, loginScript: process.env.LVZAI_LOGIN_SCRIPT })
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try {
    const result = await discoverLvzaiArrearsScope({ transport, businessDate, signal: controller.signal })
    if (args.writePath && result.state === 'passed' && result.config) writeConfig(args.writePath, result.config)
    process.stdout.write(`${JSON.stringify({
      state: result.state,
      businessDate: result.businessDate,
      regionCount: result.regionCount,
      resolvedCount: result.resolvedCount,
      totalHouseCount: result.totalHouseCount,
      totalAmount: result.totalAmount,
      issues: result.issues,
      configWritten: Boolean(args.writePath && result.config),
    })}\n`)
    if (result.state !== 'passed') process.exitCode = 2
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
  }
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'LVZAI_SCOPE_DISCOVERY_FAILED', message: error instanceof Error ? error.message : '绿仔范围发现失败' })}\n`)
  process.exitCode = 1
})
