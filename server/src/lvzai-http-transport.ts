import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LvzaiSessionExpiredError, type LvzaiArrearageTransport } from './lvzai-arrears-adapter.js'

const PSTAR_ORIGIN = 'https://pstar.firstpm.com.cn'
const OASIS_ORIGIN = 'https://oasis.firstpm.com.cn'
const PROBE_PATH = '/qdp-oasis-web/common/getRegionTree'
const MAX_STATE_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export type LvzaiHttpTransportOptions = {
  statePath?: string
  loginScript?: string
  requestTimeoutMs?: number
  loginTimeoutMs?: number
  fetchImpl?: typeof fetch
  spawnLogin?: (script: string, timeoutMs: number, signal?: AbortSignal) => Promise<void>
}

function controlledStatePath(configured?: string): string {
  return path.resolve(configured || path.join(os.homedir(), '.lvzai_state.json'))
}

function readCookieHeader(statePath: string): string {
  const stat = fs.lstatSync(statePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('绿仔会话状态必须是普通文件且不得为符号链接')
  if (stat.size <= 0 || stat.size > MAX_STATE_BYTES) throw new Error('绿仔会话状态文件大小异常')
  if ((stat.mode & 0o077) !== 0) throw new Error('绿仔会话状态文件权限必须为600')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('绿仔会话状态文件不属于当前任务用户')
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any
  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : []
  const values = cookies
    .filter((cookie: any) => typeof cookie?.name === 'string' && typeof cookie?.value === 'string' && /(^|\.)firstpm\.com\.cn$/.test(String(cookie.domain || '').replace(/^\./, '')))
    .map((cookie: any) => `${cookie.name}=${cookie.value}`)
  if (!values.length) throw new LvzaiSessionExpiredError()
  return values.join('; ')
}

async function responseJson(response: Response): Promise<unknown> {
  if ([401, 403].includes(response.status) || (response.status >= 300 && response.status < 400)) throw new LvzaiSessionExpiredError()
  if (!response.ok) throw new Error(`绿仔接口HTTP ${response.status}`)
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  if (!contentType.includes('json')) throw new LvzaiSessionExpiredError()
  const length = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('绿仔接口响应超过16MiB安全上限')
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('绿仔接口响应超过16MiB安全上限')
  if (!text.trim()) throw new Error('绿仔接口返回空响应')
  try { return JSON.parse(text) } catch { throw new Error('绿仔接口返回非JSON响应') }
}

async function defaultSpawnLogin(script: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', [script], {
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve()
    }
    const abort = () => { child.kill('SIGKILL'); finish(new Error('绿仔重新登录已取消')) }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('绿仔重新登录超时')) }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.once('error', () => finish(new Error('绿仔重新登录进程启动失败')))
    child.once('exit', code => finish(code === 0 ? undefined : new Error('绿仔重新登录失败')))
  })
}

export class LvzaiHttpTransport implements LvzaiArrearageTransport {
  readonly statePath: string
  readonly loginScript: string
  readonly requestTimeoutMs: number
  readonly loginTimeoutMs: number
  readonly fetchImpl: typeof fetch
  readonly spawnLogin: (script: string, timeoutMs: number, signal?: AbortSignal) => Promise<void>

  constructor(options: LvzaiHttpTransportOptions = {}) {
    this.statePath = controlledStatePath(options.statePath)
    this.loginScript = path.resolve(options.loginScript || path.join(__dirname, '..', 'scripts', 'lvzai-login.py'))
    this.requestTimeoutMs = Math.min(300_000, Math.max(5_000, options.requestTimeoutMs ?? 60_000))
    this.loginTimeoutMs = Math.min(600_000, Math.max(30_000, options.loginTimeoutMs ?? 300_000))
    this.fetchImpl = options.fetchImpl || fetch
    this.spawnLogin = options.spawnLogin || defaultSpawnLogin
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) : AbortSignal.timeout(this.requestTimeoutMs)
  }

  async probe(signal?: AbortSignal): Promise<boolean> {
    let cookie: string
    try { cookie = readCookieHeader(this.statePath) } catch (error) {
      if (error instanceof LvzaiSessionExpiredError || (error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
      throw error
    }
    const response = await this.fetchImpl(`${OASIS_ORIGIN}${PROBE_PATH}`, {
      method: 'GET', redirect: 'manual', signal: this.signal(signal),
      headers: { Cookie: cookie, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'first-service-cockpit-arrears-connector/1.0' },
    })
    try {
      const payload: any = await responseJson(response)
      return Array.isArray(payload?.data) && payload.data.length > 0
    } catch (error) {
      if (error instanceof LvzaiSessionExpiredError) return false
      throw error
    }
  }

  async regionTree(signal?: AbortSignal): Promise<unknown> {
    const cookie = readCookieHeader(this.statePath)
    const response = await this.fetchImpl(`${OASIS_ORIGIN}${PROBE_PATH}`, {
      method: 'GET', redirect: 'manual', signal: this.signal(signal),
      headers: { Cookie: cookie, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'first-service-cockpit-arrears-connector/1.0' },
    })
    return responseJson(response)
  }

  async relogin(signal?: AbortSignal): Promise<void> {
    const stat = fs.statSync(this.loginScript)
    if (!stat.isFile()) throw new Error('绿仔登录脚本不存在')
    await this.spawnLogin(this.loginScript, this.loginTimeoutMs, signal)
    const state = fs.lstatSync(this.statePath)
    if (!state.isFile() || state.isSymbolicLink()) throw new Error('绿仔重新登录未生成受控普通会话文件')
    fs.chmodSync(this.statePath, 0o600)
    readCookieHeader(this.statePath)
  }

  async post(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (endpoint !== '/oas/getArrearage') throw new Error('绿仔适配器拒绝未授权接口路径')
    const cookie = readCookieHeader(this.statePath)
    const response = await this.fetchImpl(`${PSTAR_ORIGIN}/qdp-polestar-web${endpoint}`, {
      method: 'POST', redirect: 'manual', signal: this.signal(signal),
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${PSTAR_ORIGIN}/qdp-polestar-webui-standard/index.html`,
        'User-Agent': 'first-service-cockpit-arrears-connector/1.0',
      },
      body: JSON.stringify(body),
    })
    return responseJson(response)
  }
}
