import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const release = 'cockpit-r68-remove-r59-sidebar-safe-area-20260813-024603'
const candidate = path.join(root, 'release-candidates', release)
const deploy = path.join(candidate, 'deploy.py')
const manifestPath = path.join(candidate, 'manifest.json')
const baselinePath = path.join(
  root,
  'release-candidates/cockpit-r67-responsive-clipping-safe-area-20260813-023728/payload/index.html',
)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

test('R68 removal-only 候选只含 deploy.py 与 manifest.json', () => {
  assert.deepEqual(fs.readdirSync(candidate).sort(), ['deploy.py', 'manifest.json'])
  assert.equal(manifest.release, release)
  assert.deepEqual(manifest.files, [])
  assert.equal(manifest.productionBaseline.payloadFiles, 0)
  assert.deepEqual(manifest.productionBaseline['index.html'], {
    size: 7637,
    sha256: '12b7d627a3a19c2df807fca5fc14ddb82d18a961ee29335aa59e6e4c8f6fc290',
  })
  assert.deepEqual(manifest.expectedResult, {
    size: 7535,
    sha256: '71e20061cb5735a72d27ee994e52fa29d97620ea9ed2ad9422b21ddd0542785d',
  })
})

test('R68 只删除 R59 精确 102 字节整行，其他字节与顺序不变', () => {
  const probe = String.raw`
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
deploy_path = Path(sys.argv[1])
baseline_path = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('r68_release_probe', deploy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
before = baseline_path.read_bytes()
after = module.transform_index(before)
offset = before.index(module.R59_LINE)
exact = after == before[:offset] + before[offset + len(module.R59_LINE):]
print(json.dumps({
  'beforeSize': len(before),
  'beforeSha': hashlib.sha256(before).hexdigest(),
  'afterSize': len(after),
  'afterSha': hashlib.sha256(after).hexdigest(),
  'removedBytes': len(module.R59_LINE),
  'removedLine': module.R59_LINE.decode(),
  'exactRemoval': exact,
  'after': after.decode(),
}, ensure_ascii=False))
`
  const result = JSON.parse(execFileSync('python3', ['-c', probe, deploy, baselinePath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }))

  assert.equal(result.beforeSize, manifest.productionBaseline['index.html'].size)
  assert.equal(result.beforeSha, manifest.productionBaseline['index.html'].sha256)
  assert.equal(result.afterSize, manifest.expectedResult.size)
  assert.equal(result.afterSha, manifest.expectedResult.sha256)
  assert.equal(result.removedBytes, 102)
  assert.equal(result.removedLine, manifest.entryTransform.removeExactlyOnce)
  assert.equal(result.exactRemoval, true)
  assert.equal(result.after.includes('aph2-r59-sidebar-content-safe-area'), false)
  for (const preserved of manifest.entryTransform.preserveExactlyOnce) {
    assert.equal(result.after.split(preserved).length - 1, 1, `${preserved} 必须保留且只出现一次`)
  }
  const order = [
    'aph2-r63-no-header-explainers-20260813-v3.css',
    'aph2-r65-sidebar-suppressed-labels-20260813-v1.css',
    'aph2-r64-ai-header-all-viewports-20260813-v1.css',
    'aph2-r67-responsive-clipping-safe-area-20260813-v1.css',
    '</head>',
  ].map(token => result.after.indexOf(token))
  assert.ok(order.every((value, index) => index === 0 || order[index - 1] < value))
})

test('R68 对任意基线字节漂移都拒绝生成新结果', () => {
  const probe = String.raw`
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('r68_drift_probe', Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = Path(sys.argv[2]).read_bytes().replace(b'<title>', b'<title data-drift="1">', 1)
try:
    module.transform_index(payload)
except RuntimeError:
    print('BLOCKED')
else:
    print('NOT_BLOCKED')
`
  const output = execFileSync('python3', ['-c', probe, deploy, baselinePath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }).trim()
  assert.equal(output, 'BLOCKED')
})

test('R68 默认与校验参数都只读，不携带 payload', () => {
  for (const args of [[], ['--verify-only'], ['--verify-payload']]) {
    const output = execFileSync('python3', [deploy, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    const result = JSON.parse(output)
    assert.equal(result.release, release)
    assert.equal(result.mode, 'verify-only')
    assert.equal(result.payloadFiles, 0)
    assert.equal(result.candidateVerified, true)
    assert.equal(result.writePerformed, false)
  }
})

test('R68 发布器仅写 index，具备全局锁、备份、前后状态门禁与回滚', () => {
  const source = fs.readFileSync(deploy, 'utf8')
  for (const required of [
    '12b7d627a3a19c2df807fca5fc14ddb82d18a961ee29335aa59e6e4c8f6fc290',
    '71e20061cb5735a72d27ee994e52fa29d97620ea9ed2ad9422b21ddd0542785d',
    'fcntl.LOCK_EX | fcntl.LOCK_NB',
    'shutil.copy2(index_target(), backup_index)',
    'write_atomic(transformed, index_target())',
    'rollback(backup_index, index_switched)',
    'mode=ro',
    'PRAGMA quick_check',
    'health_state()',
    'service_state()',
    'database_state()',
    'https://firstcare.cloud',
    'https://www.firstcare.cloud',
    'if sys.argv[1:] == ["--deploy"]',
    'assetWritePerformed',
    'databaseWritePerformed',
    'restartPerformed',
    'nginxModified',
  ]) {
    assert.ok(source.includes(required), `R68 门禁缺失：${required}`)
  }
  assert.equal(source.includes('firstcare-cloud-local/index.html'), false)
  assert.equal(source.includes('PAYLOAD /'), false)
  assert.deepEqual(manifest.deployment.writeSet, ['index.html'])
})
