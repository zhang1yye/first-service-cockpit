import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = 'cockpit-r77-region-wide-scope-20260813-150609'
const candidate = path.join(root, 'release-candidates', release)
const payload = path.join(candidate, 'payload')
const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'manifest.json'), 'utf8'))
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const stable = value => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}

function filesUnder(directory) {
  const files = []
  const walk = current => {
    for (const name of fs.readdirSync(current)) {
      const entry = path.join(current, name)
      const stat = fs.lstatSync(entry)
      assert.equal(stat.isSymbolicLink(), false, `候选不得包含软链接：${entry}`)
      if (stat.isDirectory()) walk(entry)
      else files.push(entry)
    }
  }
  walk(directory)
  return files.sort()
}

test('候选文件树与 manifest 完全一致', () => {
  const states = {}
  for (const file of filesUnder(payload)) {
    const data = fs.readFileSync(file)
    states[path.relative(payload, file)] = { exists: true, size: data.length, sha256: sha(data) }
  }
  const tree = sha(JSON.stringify(stable(states)))
  assert.equal(Object.keys(states).length, manifest.payloadFileCount)
  assert.equal(tree, manifest.payloadTreeSha256)
})

test('入口只切换 R77 主应用并追加 R77 范围样式', () => {
  const index = fs.readFileSync(path.join(payload, 'index.html'))
  const html = index.toString('utf8')
  assert.equal(index.length, manifest.expectedIndex.size)
  assert.equal(sha(index), manifest.expectedIndex.sha256)
  assert.equal((html.match(/cockpit-r77-region-wide-scope-20260813-v1/g) || []).length, 1)
  assert.equal((html.match(/aph2-r77-app-bootstrap-20260813-v1\.js/g) || []).length, 1)
  assert.equal((html.match(/aph2-r77-region-wide-scope-20260813-v1\.css/g) || []).length, 1)
  assert.doesNotMatch(html, /cockpit-r76-member-scope-20260813-v1\/app-G7HUEEER\.js/)
  assert.doesNotMatch(html, /aph2-r76-app-bootstrap-20260813-v1\.js/)
  assert.match(html, /aph2-r76-member-scope-20260813-v1\.css/)
})

test('候选包含地区全范围所需的前后端精确文件', () => {
  for (const relative of [
    'static/aph2-r77-region-wide-scope-20260813-v1.css',
    'static/aph2-r77-app-bootstrap-20260813-v1.js',
    'static/assets/cockpit-r77-region-wide-scope-20260813-v1/chunk-R65SIMPLEADMIN.js',
    'server/dist/routes/users.js',
    'server/dist/service-center-access.js',
    'server/dist/routes/weekly-meetings.js',
    'server/dist/routes/arrears-analysis.js',
    'server/dist/routes/regional-assistant.js',
  ]) assert.ok(fs.existsSync(path.join(payload, relative)), `缺少 ${relative}`)
})

test('发布器默认只校验且保留原子发布与回滚', () => {
  const deploy = fs.readFileSync(path.join(candidate, 'deploy.py'), 'utf8')
  assert.match(deploy, /verify_only\(\) if not sys\.argv\[1:\]/)
  assert.match(deploy, /fcntl\.flock/)
  assert.match(deploy, /atomic_copy/)
  assert.match(deploy, /发布失败并已回滚/)
  assert.doesNotMatch(deploy, /DROP TABLE|DELETE FROM|UPDATE users/)
})
