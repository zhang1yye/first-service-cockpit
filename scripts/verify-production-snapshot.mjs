import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'config/production-baseline.json'), 'utf8'))
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const mirror = fs.readFileSync(path.join(root, baseline.mirrorIndex))
const references = [...mirror.toString('utf8').matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
const artifacts = new Map(baseline.localArtifacts.map(item => [item.reference, item]))
const failures = []
if (sha256(mirror) !== baseline.indexSha256) failures.push('入口镜像哈希不匹配')
for (const entrypoint of baseline.entrypoints) {
  if (entrypoint.direct !== false && !references.includes(entrypoint.reference)) failures.push(`入口未引用 ${entrypoint.reference}`)
  const artifact = artifacts.get(entrypoint.reference)
  if (!artifact) { failures.push(`缺少本地快照 ${entrypoint.reference}`); continue }
  const file = path.join(root, artifact.path)
  if (!fs.existsSync(file)) { failures.push(`快照文件不存在 ${artifact.path}`); continue }
  const actual = sha256(fs.readFileSync(file))
  if (actual !== entrypoint.sha256 || actual !== artifact.sha256) failures.push(`快照哈希不匹配 ${artifact.path}`)
}
const result = { release: baseline.release, indexSha256: baseline.indexSha256, assets: baseline.entrypoints.length, failures, ok: failures.length === 0 }
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
