import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const candidate = path.join(root, 'release-candidates/cockpit-r81-snapshot-status-consistency-20260816-190927')
const manifest = JSON.parse(readFileSync(path.join(candidate, 'manifest.json'), 'utf8'))
const digest = (data) => ({ size: data.length, sha256: createHash('sha256').update(data).digest('hex') })

test('候选只包含两个后端目标文件', () => {
  assert.deepEqual(readdirSync(candidate).sort(), ['deploy.py', 'manifest.json', 'payload'])
  assert.deepEqual(manifest.files.map((item) => item.path).sort(), [
    'dist/routes/data-sources.js', 'src/routes/data-sources.ts',
  ])
})

test('候选资产等于冻结源码与构建结果', () => {
  for (const item of manifest.files) {
    const payload = readFileSync(path.join(candidate, 'payload', item.path))
    assert.deepEqual(digest(payload), item.expected)
  }
})

test('修复仅增加运行记录与实际快照数的一致性校验', () => {
  const source = readFileSync(path.join(candidate, 'payload/src/routes/data-sources.ts'), 'utf8')
  assert.match(source, /actualSnapshotCount/)
  assert.match(source, /snapshotRecordMismatch/)
  assert.match(source, /运行记录与生产数据不一致/)
  assert.doesNotMatch(source, /DELETE FROM snapshot_runs|UPDATE snapshot_runs/)
})

test('发布器默认只校验且明确不写数据库', () => {
  const source = readFileSync(path.join(candidate, 'deploy.py'), 'utf8')
  assert.match(source, /if not sys\.argv\[1:\]:\s*\n\s*result = verify_only\(\)/)
  assert.equal(manifest.databaseWrite, false)
  assert.equal(manifest.serviceRestart, true)
})
