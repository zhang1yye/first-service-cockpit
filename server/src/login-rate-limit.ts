import type { Request } from 'express'

/**
 * 登录防爆破：按客户端 IP 统计失败次数。
 * 15 分钟窗口内失败达到阈值后锁定该 IP 15 分钟。
 * 服务为单实例部署，使用进程内 Map 即可；重启后锁定清空（可接受）。
 */

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 8
const LOCK_MS = 15 * 60 * 1000

type Entry = { failures: number; firstAt: number; lockedUntil: number }
const store = new Map<string, Entry>()

export function clientIp(req: Request): string {
  // Express仅信任同机反向代理，并从右向左解析代理链；不得直接采用客户端可伪造的X-Forwarded-For首项。
  return req.ip || req.socket.remoteAddress || 'unknown'
}

export function loginLocked(req: Request): { locked: boolean; retryAfterSeconds: number } {
  const entry = store.get(clientIp(req))
  if (entry && entry.lockedUntil > Date.now()) {
    return {
      locked: true,
      retryAfterSeconds: Math.ceil((entry.lockedUntil - Date.now()) / 1000),
    }
  }
  return { locked: false, retryAfterSeconds: 0 }
}

export function recordLoginFailure(req: Request): void {
  const now = Date.now()
  const ip = clientIp(req)
  const entry = store.get(ip)
  if (!entry || entry.firstAt + WINDOW_MS <= now) {
    store.set(ip, { failures: 1, firstAt: now, lockedUntil: 0 })
    return
  }
  entry.failures += 1
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS
  }
}

export function resetLoginFailures(req: Request): void {
  store.delete(clientIp(req))
}

// 定期清理过期条目，避免内存无限增长。
const cleaner = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (entry.lockedUntil <= now && entry.firstAt + WINDOW_MS <= now) {
      store.delete(key)
    }
  }
}, 5 * 60 * 1000)
cleaner.unref?.()
