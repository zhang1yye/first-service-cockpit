import path from 'node:path'

const LEGACY_FIXED_ENTRY_ROOT = '/home/ubuntu/cockpit'

type FixedEntryEnvironment = { COCKPIT_ROOT?: string }

/**
 * 经营固定入口只由 COCKPIT_ROOT 定位。未配置时仅兼容历史生产目录，
 * 禁止 HOME/COCKPIT_HOME 把私有环境的读写绕回其他驾驶舱目录。
 */
export function fixedEntryRoot(env: FixedEntryEnvironment = process.env): string {
  const configured = String(env.COCKPIT_ROOT || '').trim()
  return path.resolve(configured || LEGACY_FIXED_ENTRY_ROOT)
}

export function fixedEntryPath(fileName: string, env: FixedEntryEnvironment = process.env): string {
  const normalized = String(fileName || '').trim()
  if (!normalized || path.basename(normalized) !== normalized || normalized === '.' || normalized === '..') {
    throw new Error('固定入口文件名无效')
  }
  return path.join(fixedEntryRoot(env), normalized)
}
