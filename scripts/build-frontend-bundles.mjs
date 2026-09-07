import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function buildBundle(name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config/frontend-bundle-manifest.json'), 'utf8'))
  const bundle = manifest.bundles[name]
  if (!bundle) throw new Error(`未知bundle：${name}`)
  if (!bundle.rebuildable) throw new Error(`${name} bundle尚未标记为可重建`)
  const parts = bundle.sources.map(source => {
    const sourcePath = typeof source === 'string' ? source : source.path
    const file = path.join(root, sourcePath)
    if (!fs.existsSync(file)) throw new Error(`缺少${name} bundle源文件：${sourcePath}`)
    const contents = fs.readFileSync(file)
    const actual = sha256(contents)
    if (typeof source !== 'string' && source.sha256 && actual !== source.sha256) throw new Error(`${name} bundle源文件哈希漂移：${sourcePath}`)
    return `${typeof source === 'string' ? '' : source.prefix || ''}${contents.toString('utf8').trim()}`
  })
  const separator = bundle.separator || manifest.separator
  const output = `${parts.join(separator)}${separator}`
  const outputBuffer = Buffer.from(output)
  return {
    output,
    sha256: sha256(outputBuffer),
    bytes: outputBuffer.length,
    expectedSha256: bundle.expectedSha256,
    expectedBytes: bundle.expectedBytes,
    sourceCount: bundle.sources.length,
    ok: sha256(outputBuffer) === bundle.expectedSha256 && outputBuffer.length === bundle.expectedBytes,
  }
}

export function buildHeadBundle() { return buildBundle('head') }
export function buildDeferBundle() { return buildBundle('defer') }
export function buildStylesheetBundle() { return buildBundle('stylesheet') }

function main() {
  const name = process.argv.includes('--stylesheet') ? 'stylesheet' : process.argv.includes('--defer') ? 'defer' : 'head'
  const result = buildBundle(name)
  const outputArg = process.argv.indexOf('--output')
  if (outputArg >= 0) {
    const target = process.argv[outputArg + 1]
    if (!target) throw new Error('--output需要明确文件路径')
    fs.writeFileSync(path.resolve(target), result.output)
  }
  process.stdout.write(`${JSON.stringify({ bundle: name, ...result, output: undefined }, null, 2)}\n`)
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
