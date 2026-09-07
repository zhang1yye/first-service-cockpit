import { Worker } from 'node:worker_threads'
import type { ArrearsWorkbookProfile } from './arrears-columns.js'

export interface WorkbookSandboxOptions {
  timeoutMs?: number
  profile?: ArrearsWorkbookProfile
}

export function parseWorkbookRowsSandboxed(
  buffer: Buffer,
  originalName: string,
  maxRows: number,
  options: WorkbookSandboxOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const timeoutMs = options.timeoutMs ?? 8_000
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./arrears-workbook-worker.js', import.meta.url), {
      workerData: { buffer, originalName, maxRows, profile: options.profile || '' },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    })
    let settled = false
    const finish = (error?: Error, rows?: Array<Record<string, unknown>>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(error)
      else resolve(rows || [])
    }
    const timer = setTimeout(() => finish(new Error('工作簿解析超时，已终止隔离解析进程')), Math.max(0, timeoutMs))
    worker.once('message', (message: any) => {
      if (message?.ok && Array.isArray(message.rows)) finish(undefined, message.rows)
      else finish(new Error(String(message?.error || '工作簿解析失败')))
    })
    worker.once('error', () => finish(new Error('工作簿隔离解析进程异常')))
    worker.once('exit', code => {
      if (!settled && code !== 0) finish(new Error('工作簿隔离解析进程异常退出'))
    })
  })
}
