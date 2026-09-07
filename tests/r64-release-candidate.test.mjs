import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const release = 'cockpit-r64-ai-header-all-viewports-20260813-020634'
const candidate = path.join(root, 'release-candidates', release)
const payload = path.join(candidate, 'payload')
const deploy = path.join(candidate, 'deploy.py')
const manifestPath = path.join(candidate, 'manifest.json')
const baselinePath = path.join(
  root,
  'release-candidates/cockpit-r63-no-header-explainers-20260813-015457/payload/web/index.html',
)
const productRoot = path.join(root, 'firstcare-cloud-local')
const jsAsset = 'aph2-r64-ai-header-all-viewports-20260813-v1.js'
const cssAsset = 'aph2-r64-ai-header-all-viewports-20260813-v1.css'
const allowedAssets = [cssAsset, jsAsset]
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const read = file => fs.readFileSync(file)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(prefix, entry.name)
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(absolute, relative) : [relative]
  })
}

test('R64 候选只含两项产品资产、manifest 与默认只读发布器', () => {
  assert.deepEqual(listFiles(candidate).sort(), [
    'deploy.py',
    'manifest.json',
    `payload/${cssAsset}`,
    `payload/${jsAsset}`,
  ])
  assert.equal(manifest.release, release)
  assert.deepEqual(Object.keys(manifest.productionBaseline), [
    'index.html',
    'immutableAssets',
  ])
  assert.deepEqual(manifest.productionBaseline['index.html'], {
    size: 7116,
    sha256: 'f12ecd9f116fa71e37b594932716a8c4c544c716b1847cc83952992fc9b51935',
  })
  assert.deepEqual(manifest.expectedResult, {
    size: 7216,
    sha256: 'ce6019ba7302a2fb6cb4589a4a88099741e95704e96d25e066c583ac2c227d0e',
  })
  assert.deepEqual(manifest.files.map(item => item.path).sort(), allowedAssets)
})

test('R64 候选资产与当前产品资产字节一致，大小和 SHA 与 manifest 一致', () => {
  for (const item of manifest.files) {
    const candidateBytes = read(path.join(payload, item.path))
    const productBytes = read(path.join(productRoot, item.path))
    assert.deepEqual(candidateBytes, productBytes, `${item.path} 候选快照与产品资产不一致`)
    assert.equal(candidateBytes.length, item.size)
    assert.equal(sha256(candidateBytes), item.sha256)
  }
})

test('R64 只删除 R59 一行，保留 R63 三项引用并在精确锚点后增加 CSS/JS', () => {
  const probe = String.raw`
import collections
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
deploy_path = Path(sys.argv[1])
baseline_path = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('r64_release_probe', deploy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
before = baseline_path.read_text(encoding='utf-8')
after = module.transform_index(before)
before_lines = collections.Counter(before.splitlines(keepends=True))
after_lines = collections.Counter(after.splitlines(keepends=True))
removed = [line.strip() for line in (before_lines - after_lines).elements()]
added = [line.strip() for line in (after_lines - before_lines).elements()]
print(json.dumps({
  'beforeSize': len(before.encode()),
  'beforeSha': hashlib.sha256(before.encode()).hexdigest(),
  'afterSize': len(after.encode()),
  'afterSha': hashlib.sha256(after.encode()).hexdigest(),
  'removed': removed,
  'added': added,
  'after': after,
}, ensure_ascii=False))
`
  const result = JSON.parse(execFileSync('python3', ['-c', probe, deploy, baselinePath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }))

  assert.equal(result.beforeSize, 7116)
  assert.equal(result.beforeSha, manifest.productionBaseline['index.html'].sha256)
  assert.equal(result.afterSize, manifest.expectedResult.size)
  assert.equal(result.afterSha, manifest.expectedResult.sha256)
  assert.deepEqual(result.removed, [
    '<link rel="stylesheet" href="/aph2-r59-sidebar-content-safe-area-20260813-v1.css?v=r59-sidebar1">',
  ])
  assert.deepEqual(result.added.sort(), [
    '<link rel="stylesheet" href="/aph2-r64-ai-header-all-viewports-20260813-v1.css?v=r64-ai-header1">',
    '<script src="/aph2-r64-ai-header-all-viewports-20260813-v1.js?v=r64-ai-header1" defer></script>',
  ].sort())

  for (const preserved of manifest.entryTransform.preserveExactlyOnce) {
    assert.equal(result.after.split(preserved).length - 1, 1, `${preserved} 必须保留且只保留一次`)
  }
  assert.equal(result.after.includes(manifest.entryTransform.removeExactlyOnce), false)
  const r63Css = manifest.entryTransform.insertCssAfter
  const r64Css = '/aph2-r64-ai-header-all-viewports-20260813-v1.css?v=r64-ai-header1'
  const r50Js = manifest.entryTransform.insertJsAfter
  const r64Js = '/aph2-r64-ai-header-all-viewports-20260813-v1.js?v=r64-ai-header1'
  assert.ok(result.after.indexOf(r63Css) < result.after.indexOf(r64Css))
  assert.ok(result.after.indexOf(r64Css) < result.after.indexOf('</head>'))
  assert.ok(result.after.indexOf(r50Js) < result.after.indexOf(r64Js))
  assert.ok(result.after.indexOf(r64Js) < result.after.indexOf('</body>'))
})

test('R64 默认和 --verify-payload 均只校验，本地不产生生产写入', () => {
  for (const args of [[], ['--verify-payload']]) {
    const output = execFileSync('python3', [deploy, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    const result = JSON.parse(output)
    assert.equal(result.release, release)
    assert.equal(result.mode, 'verify-only')
    assert.equal(result.payloadVerified, true)
    assert.equal(result.writePerformed, false)
    assert.equal(result.files, 2)
  }
})

test('R64 发布器具备基线阻断、全局锁、路径防护、资产先行、只读 DB 与失败回滚', () => {
  const source = fs.readFileSync(deploy, 'utf8')
  for (const required of [
    'f12ecd9f116fa71e37b594932716a8c4c544c716b1847cc83952992fc9b51935',
    'fcntl.LOCK_EX | fcntl.LOCK_NB',
    'os.path.commonpath',
    'result.is_symlink()',
    'mode=ro',
    'PRAGMA quick_check',
    'https://firstcare.cloud',
    'https://www.firstcare.cloud',
    'copy_atomic(PAYLOAD / relative, target(relative))',
    'write_atomic(transformed, target(INDEX))',
    'rollback(backup_index, installed_assets, index_switched)',
    'if sys.argv[1:] == ["--deploy"]',
    'databaseWritePerformed',
    'restartPerformed',
    'nginxModified',
  ]) {
    assert.ok(source.includes(required), `发布门禁缺失：${required}`)
  }
  assert.ok(
    source.indexOf('copy_atomic(PAYLOAD / relative, target(relative))')
      < source.indexOf('write_atomic(transformed, target(INDEX))'),
    '不可变资产必须先于 root index 切换',
  )
  assert.equal(source.includes('firstcare-cloud-local/index.html'), false)
  assert.equal(source.includes('admin/index.html'), false)
})
