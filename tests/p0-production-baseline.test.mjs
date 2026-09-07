import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { assetReferences, sha256 } from '../scripts/check-production-baseline.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'config/production-baseline.json'), 'utf8'))
const protectedBaseline = JSON.parse(fs.readFileSync(path.join(root, 'config/protected-routes-baseline.json'), 'utf8'))

test('R89不可变候选入口精确对应已记录的生产入口', () => {
  const index = fs.readFileSync(path.join(root, baseline.mirrorIndex))
  const references = assetReferences(index.toString('utf8'))
  assert.equal(sha256(index), baseline.indexSha256)
  assert.deepEqual(references, baseline.entrypoints.map(entrypoint => entrypoint.reference))
  for (const artifact of baseline.localArtifacts) {
    const file = path.join(root, artifact.path)
    assert.ok(fs.existsSync(file), `候选资产不存在：${artifact.path}`)
    assert.equal(sha256(fs.readFileSync(file)), artifact.sha256, `候选资产哈希漂移：${artifact.path}`)
  }
})

test('三个已验收路由的保护文件未发生静默变化', () => {
  assert.deepEqual(protectedBaseline.routes, ['/daily', '/payment', '/collection'])
  for (const [relative, expected] of Object.entries(protectedBaseline.files)) {
    const file = path.join(root, relative)
    assert.ok(fs.existsSync(file), `保护文件不存在：${relative}`)
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    assert.equal(actual, expected, `保护文件发生变化，必须单独评审并显式更新基线：${relative}`)
  }
})

test('R89三个bundle可重建，但历史补丁链不能冒充单一React应用源码', () => {
  assert.equal(baseline.sourceStatus.rebuildable, false)
  assert.match(baseline.sourceStatus.reason, /bundle|React源码/)
})
