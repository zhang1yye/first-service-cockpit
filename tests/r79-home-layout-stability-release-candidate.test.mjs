import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const release = 'cockpit-r79-home-layout-stability-20260814-134719'
const candidate = path.join(root, 'release-candidates', release)
const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'manifest.json'), 'utf8'))
const asset = fs.readFileSync(path.join(candidate, 'payload', manifest.asset.path))
const source = fs.readFileSync(path.join(root, 'firstcare-cloud-local', manifest.asset.path))
const sha = data => crypto.createHash('sha256').update(data).digest('hex')

test('R79候选只包含冻结的单一不可变JS', () => {
  const names = fs.readdirSync(path.join(candidate, 'payload'))
  assert.deepEqual(names, [manifest.asset.path])
  assert.equal(asset.length, manifest.asset.size)
  assert.equal(sha(asset), manifest.asset.sha256)
  assert.deepEqual(asset, source)
})

test('R79入口是基于R77生产基线的单行增量', () => {
  assert.deepEqual(manifest.baselineIndex, {size:8739, sha256:'4916bd30f2715484f20905a6d3e66cfea6735b242627416046aff3dcccc1d6d1'})
  assert.equal(Buffer.byteLength(manifest.indexInsert), 100)
  assert.match(manifest.indexInsertAfter, /aph2-r8-home-layout/)
  assert.match(manifest.indexInsert, /aph2-r79-home-layout-stability/)
  assert.equal(manifest.expectedIndex.size, manifest.baselineIndex.size + 100)
})

test('R79发布器默认只读、原子写入且失败回滚', () => {
  const deploy = fs.readFileSync(path.join(candidate, 'deploy.py'), 'utf8')
  assert.match(deploy, /result = verify_only\(\)/)
  assert.match(deploy, /sys\.argv\[1:\] == \["--deploy"\]/)
  assert.match(deploy, /fcntl\.flock/)
  assert.match(deploy, /atomic_write\(asset, target\)/)
  assert.match(deploy, /atomic_write\(expected, INDEX\)/)
  assert.match(deploy, /发布失败并已回滚/)
  assert.doesNotMatch(deploy, /systemctl", "(stop|start|restart)/)
})

test('R79发布范围不包含接口、数据库写入或其他页面资产', () => {
  const text = asset.toString('utf8')
  assert.doesNotMatch(text, /fetch\s*\(|\/api\/|localStorage|sessionStorage/)
  assert.equal(manifest.restartService, false)
  assert.equal(manifest.databaseWrite, false)
})
