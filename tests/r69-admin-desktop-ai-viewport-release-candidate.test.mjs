import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const release = 'cockpit-r69-admin-desktop-ai-viewport-20260813-030049'
const candidate = path.join(root, 'release-candidates', release)
const payload = path.join(candidate, 'payload')
const deploy = path.join(candidate, 'deploy.py')
const manifestPath = path.join(candidate, 'manifest.json')
const productAsset = path.join(
  root,
  'firstcare-cloud-local/aph2-r69-admin-desktop-ai-viewport-20260813-v1.css',
)
const candidateAsset = path.join(
  payload,
  'aph2-r69-admin-desktop-ai-viewport-20260813-v1.css',
)
const r67Snapshot = path.join(
  root,
  'release-candidates/cockpit-r67-responsive-clipping-safe-area-20260813-023728/payload/index.html',
)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(prefix, entry.name)
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(absolute, relative) : [relative]
  })
}

test('R69 候选仅含单 CSS、manifest 与默认只读发布器', () => {
  assert.deepEqual(listFiles(candidate).sort(), [
    'deploy.py',
    'manifest.json',
    'payload/aph2-r69-admin-desktop-ai-viewport-20260813-v1.css',
  ])
  assert.equal(manifest.release, release)
  assert.deepEqual(manifest.files.map(item => item.path), [
    'aph2-r69-admin-desktop-ai-viewport-20260813-v1.css',
  ])
  assert.deepEqual(manifest.productionBaseline['index.html'], {
    size: 7535,
    sha256: '71e20061cb5735a72d27ee994e52fa29d97620ea9ed2ad9422b21ddd0542785d',
  })
  assert.deepEqual(manifest.expectedResult, {
    size: 7647,
    sha256: '1e242bea806e2b5b87576aaab8c6a90de78a777e4425c6826497e4c44f4e85a7',
  })
})

test('R69 候选 CSS 与冻结产品资产字节一致', () => {
  const product = fs.readFileSync(productAsset)
  const frozen = fs.readFileSync(candidateAsset)
  assert.deepEqual(frozen, product)
  assert.equal(frozen.length, 315)
  assert.equal(
    sha256(frozen),
    '788e3578e35ad772e0828a762b0be0f76637a85901c31eb50cc21b702c1741ef',
  )
  const css = frozen.toString('utf8')
  assert.match(css, /@media \(min-width: 641px\)/)
  assert.match(css, /header\.aph-admin-shell-header\.aph-r64-ai-host/)
  assert.match(css, /position: fixed !important/)
  assert.match(css, /inset: 0 0 auto 60px !important/)
})

test('R69 只在 R67 整行后增加 112 字节 CSS 引用，其他字节不变', () => {
  const probe = String.raw`
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('r69_release_probe', Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
r67 = Path(sys.argv[2]).read_bytes()
r59 = b'    <link rel="stylesheet" href="/aph2-r59-sidebar-content-safe-area-20260813-v1.css?v=r59-sidebar1">\n'
assert r67.count(r59) == 1
before = r67.replace(r59, b'', 1)
after = module.transform_index(before)
offset = before.index(module.R67_LINE) + len(module.R67_LINE)
print(json.dumps({
  'beforeSize': len(before),
  'beforeSha': hashlib.sha256(before).hexdigest(),
  'afterSize': len(after),
  'afterSha': hashlib.sha256(after).hexdigest(),
  'addedBytes': len(module.R69_LINE),
  'addedLine': module.R69_LINE.decode(),
  'exactInsertion': after == before[:offset] + module.R69_LINE + before[offset:],
  'after': after.decode(),
}, ensure_ascii=False))
`
  const result = JSON.parse(execFileSync('python3', ['-c', probe, deploy, r67Snapshot], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }))

  assert.equal(result.beforeSize, manifest.productionBaseline['index.html'].size)
  assert.equal(result.beforeSha, manifest.productionBaseline['index.html'].sha256)
  assert.equal(result.afterSize, manifest.expectedResult.size)
  assert.equal(result.afterSha, manifest.expectedResult.sha256)
  assert.equal(result.addedBytes, manifest.entryTransform.addedBytes)
  assert.equal(result.addedLine, manifest.entryTransform.insertExactlyOnce)
  assert.equal(result.exactInsertion, true)
  assert.equal(result.after.includes(manifest.entryTransform.forbidReference), false)
  for (const preserved of manifest.entryTransform.preserveExactlyOnce) {
    assert.equal(result.after.split(preserved).length - 1, 1, `${preserved} 必须保留且唯一`)
  }
  assert.ok(
    result.after.indexOf('aph2-r67-responsive-clipping-safe-area-20260813-v1.css')
      < result.after.indexOf('aph2-r69-admin-desktop-ai-viewport-20260813-v1.css'),
  )
})

test('R69 默认与校验参数均只读，不执行发布', () => {
  for (const args of [[], ['--verify-only'], ['--verify-payload']]) {
    const output = execFileSync('python3', [deploy, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    const result = JSON.parse(output)
    assert.equal(result.release, release)
    assert.equal(result.mode, 'verify-only')
    assert.equal(result.files, 1)
    assert.equal(result.payloadVerified, true)
    assert.equal(result.writePerformed, false)
  }
})

test('R69 发布器具备哈希阻断、全局锁、资产先行、状态门禁与回滚', () => {
  const source = fs.readFileSync(deploy, 'utf8')
  for (const required of [
    '71e20061cb5735a72d27ee994e52fa29d97620ea9ed2ad9422b21ddd0542785d',
    '1e242bea806e2b5b87576aaab8c6a90de78a777e4425c6826497e4c44f4e85a7',
    'fcntl.LOCK_EX | fcntl.LOCK_NB',
    'os.path.commonpath',
    'destination.is_symlink()',
    'mode=ro',
    'PRAGMA quick_check',
    'copy_atomic(PAYLOAD / ASSET, target(ASSET))',
    'write_atomic(transformed, target(INDEX))',
    'rollback(backup_index, asset_installed, index_switched)',
    'https://firstcare.cloud',
    'https://www.firstcare.cloud',
    'if sys.argv[1:] == ["--deploy"]',
    'databaseWritePerformed',
    'restartPerformed',
    'nginxModified',
  ]) {
    assert.ok(source.includes(required), `R69 发布门禁缺失：${required}`)
  }
  assert.ok(
    source.indexOf('copy_atomic(PAYLOAD / ASSET, target(ASSET))')
      < source.indexOf('write_atomic(transformed, target(INDEX))'),
  )
  assert.equal(source.includes('firstcare-cloud-local/index.html'), false)
})
