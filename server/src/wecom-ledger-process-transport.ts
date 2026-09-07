import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import type { WecomLedgerTransport } from './wecom-ledger-connector.js'

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const ALLOWED_CREDENTIAL_ENVIRONMENT = ['WECOM_READ_TOKEN', 'WECOM_SESSION_FILE'] as const

export class WecomLedgerSessionExpiredError extends Error {
  constructor() {
    super('企业微信只读会话已失效')
    this.name = 'WecomLedgerSessionExpiredError'
  }
}

function assertOwnedExecutable(filePath: string): void {
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('企业微信只读提取器必须为普通文件且不得为符号链接')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('企业微信只读提取器不属于当前任务用户')
  if ((stat.mode & 0o022) !== 0) throw new Error('企业微信只读提取器不得允许组或其他用户写入')
  if ((stat.mode & 0o100) === 0) throw new Error('企业微信只读提取器缺少任务用户执行权限')
}

function assertSessionFile(): void {
  const value = String(process.env.WECOM_SESSION_FILE || '').trim()
  if (!value) return
  const stat = fs.lstatSync(value)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('企业微信会话文件必须为普通文件且不得为符号链接')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('企业微信会话文件不属于当前任务用户')
  if ((stat.mode & 0o777) !== 0o600) throw new Error('企业微信会话文件权限必须为600')
  if (stat.size <= 0 || stat.size > 16 * 1024 * 1024) throw new Error('企业微信会话文件大小异常')
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: os.homedir(),
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    NODE_ENV: process.env.NODE_ENV || 'development',
  }
  for (const name of ALLOWED_CREDENTIAL_ENVIRONMENT) if (process.env[name]) env[name] = process.env[name]
  return env
}

export class WecomLedgerProcessTransport implements WecomLedgerTransport {
  readonly executablePath: string
  readonly timeoutMs: number
  readonly maximumResponseBytes: number

  constructor(options: { executablePath: string; timeoutMs?: number; maximumResponseBytes?: number }) {
    this.executablePath = String(options.executablePath || '').trim()
    this.timeoutMs = Math.max(1_000, Math.min(10 * 60_000, Math.trunc(options.timeoutMs || 120_000)))
    this.maximumResponseBytes = Math.max(1_024, Math.min(MAX_RESPONSE_BYTES, Math.trunc(options.maximumResponseBytes || MAX_RESPONSE_BYTES)))
    if (!this.executablePath) throw new Error('缺少企业微信只读提取器路径')
    assertOwnedExecutable(this.executablePath)
    assertSessionFile()
  }

  async readSheet(input: { documentId: string; sheetId: string; businessDate: string }, signal?: AbortSignal): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    assertOwnedExecutable(this.executablePath)
    assertSessionFile()
    const request = JSON.stringify({ operation: 'read_sheet', documentId: input.documentId, sheetId: input.sheetId, businessDate: input.businessDate })
    return new Promise((resolve, reject) => {
      const child = spawn(this.executablePath, [], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: childEnvironment() })
      const chunks: Buffer[] = []
      let bytes = 0
      let settled = false
      const finish = (error?: Error, result?: { rows: Record<string, unknown>[]; total: number }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(result!)
      }
      const abort = () => { child.kill('SIGKILL'); finish(new Error('企业微信只读提取已取消')) }
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('企业微信只读提取超时')) }, this.timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) return abort()
      child.on('error', error => finish(new Error(`企业微信只读提取器启动失败：${error.message}`)))
      child.stdout.on('data', chunk => {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > this.maximumResponseBytes) {
          child.kill('SIGKILL')
          finish(new Error('企业微信只读提取响应超过16MiB安全上限'))
          return
        }
        chunks.push(buffer)
      })
      child.once('exit', code => {
        if (settled) return
        if (code === 42) return finish(new WecomLedgerSessionExpiredError())
        if (code !== 0) return finish(new Error('企业微信只读提取器执行失败'))
        let payload: unknown
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return finish(new Error('企业微信只读提取器返回非JSON')) }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return finish(new Error('企业微信只读提取器响应结构无效'))
        const value = payload as Record<string, unknown>
        if (!Array.isArray(value.rows) || !Number.isInteger(value.total) || Number(value.total) < 0) return finish(new Error('企业微信只读提取器响应缺少rows或total'))
        if (Number(value.total) !== value.rows.length || value.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return finish(new Error('企业微信只读提取器声明行数与明细不一致'))
        finish(undefined, { rows: value.rows as Record<string, unknown>[], total: Number(value.total) })
      })
      child.stdin.end(request)
    })
  }
}
