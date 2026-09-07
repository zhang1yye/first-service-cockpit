import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = path.join(
  ROOT,
  'release-candidates/cockpit-r50-full-accessibility-20260812-222225',
)
const PAYLOAD = path.join(RELEASE, 'payload')
const MAIN_INDEX = path.join(PAYLOAD, 'index.html')
const ADMIN_INDEX = path.join(PAYLOAD, 'admin/index.html')
const ARREARS_INDEX = path.join(PAYLOAD, 'arrears/index.html')

const EXPECTED_FILES = [
  'admin/aph2-r46-admin-accessibility-20260812-v1.css',
  'admin/aph2-r46-admin-accessibility-20260812-v1.js',
  'admin/index.html',
  'aph2-r45-global-accessibility-20260812-v1.css',
  'aph2-r45-global-accessibility-20260812-v1.js',
  'aph2-r47-project-accessibility-20260812-v1.css',
  'aph2-r47-project-accessibility-20260812-v1.js',
  'arrears/aph2-r50-arrears-accessibility-20260812-v1.css',
  'arrears/index.html',
  'index.html',
]

const OVERLAY_FILES = EXPECTED_FILES.filter(file => !file.endsWith('index.html'))

function read(relativePath) {
  return fs.readFileSync(path.join(PAYLOAD, relativePath), 'utf8')
}

function occurrences(source, value) {
  return source.split(value).length - 1
}

function payloadTree(directory = PAYLOAD, prefix = '') {
  const entries = []
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, dirent.name)
    const absolute = path.join(directory, dirent.name)
    assert.equal(dirent.isSymbolicLink(), false, `候选负载不得包含软链接：${relative}`)
    if (dirent.isDirectory()) {
      entries.push(`${relative}/`)
      entries.push(...payloadTree(absolute, relative))
    } else {
      assert.equal(dirent.isFile(), true, `候选负载只允许普通文件：${relative}`)
      entries.push(relative)
    }
  }
  return entries.sort()
}

test('R50 主入口保留 R48/R49，并按序加载 R45/R46/R47 无障碍层', () => {
  const html = fs.readFileSync(MAIN_INDEX, 'utf8')
  const styleAssets = [
    '/aph2-r48-home-banner-20260812-v1.css?v=r48-banner1',
    '/aph2-r49-year-placement-20260812-v1.css?v=r49-year1',
    '/aph2-r45-global-accessibility-20260812-v1.css?v=r45-a11y1',
    '/admin/aph2-r46-admin-accessibility-20260812-v1.css?v=r46-admin-a11y1',
    '/aph2-r47-project-accessibility-20260812-v1.css?v=r47-project-a11y1',
  ]
  const scriptAssets = [
    '/aph2-r45-global-accessibility-20260812-v1.js?v=r45-a11y1',
    '/admin/aph2-r46-admin-accessibility-20260812-v1.js?v=r46-admin-a11y1',
    '/aph2-r47-project-accessibility-20260812-v1.js?v=r47-project-a11y1',
  ]

  for (const asset of [...styleAssets, ...scriptAssets]) {
    assert.equal(occurrences(html, asset), 1, `入口必须且只能加载一次 ${asset}`)
  }
  for (let index = 1; index < styleAssets.length; index += 1) {
    assert.ok(
      html.indexOf(styleAssets[index]) > html.indexOf(styleAssets[index - 1]),
      `样式顺序错误：${styleAssets[index - 1]} 应先于 ${styleAssets[index]}`,
    )
  }
  for (let index = 1; index < scriptAssets.length; index += 1) {
    assert.ok(
      html.indexOf(scriptAssets[index]) > html.indexOf(scriptAssets[index - 1]),
      `脚本顺序错误：${scriptAssets[index - 1]} 应先于 ${scriptAssets[index]}`,
    )
  }
})

test('R50 后台入口只叠加公共 R45 与后台 R46', () => {
  const html = fs.readFileSync(ADMIN_INDEX, 'utf8')
  for (const asset of [
    '/aph2-r45-global-accessibility-20260812-v1.css?v=r45-a11y1',
    '/admin/aph2-r46-admin-accessibility-20260812-v1.css?v=r46-admin-a11y1',
    '/aph2-r45-global-accessibility-20260812-v1.js?v=r45-a11y1',
    '/admin/aph2-r46-admin-accessibility-20260812-v1.js?v=r46-admin-a11y1',
  ]) {
    assert.equal(occurrences(html, asset), 1, `后台入口必须且只能加载一次 ${asset}`)
  }
  assert.doesNotMatch(html, /aph2-r47-project-accessibility/)
})

test('R50 所有入口明确排除 cloud remediation、importmap 与 bootstrap', () => {
  const entries = [MAIN_INDEX, ADMIN_INDEX, ARREARS_INDEX]
    .map(file => fs.readFileSync(file, 'utf8'))
    .join('\n')

  assert.doesNotMatch(entries, /aph2-r45-cloud-remediation/i)
  assert.doesNotMatch(entries, /type\s*=\s*["']importmap["']/i)
  assert.doesNotMatch(entries, /bootstrap/i)
})

test('R50 欠费入口只追加指定的无障碍样式', () => {
  const html = fs.readFileSync(ARREARS_INDEX, 'utf8')
  const prior = '/arrears/arrears-home-palette-20260812-v1.css?v=r35-home-palette1'
  const r50 = '/arrears/aph2-r50-arrears-accessibility-20260812-v1.css?v=r50-arrears-a11y1'

  assert.equal(occurrences(html, r50), 1)
  assert.ok(html.indexOf(prior) >= 0, '欠费入口必须保留既有首页配色层')
  assert.ok(html.indexOf(r50) > html.indexOf(prior), 'R50 欠费无障碍层必须后置加载')
  assert.doesNotMatch(html, /aph2-r4[567]-(?:global|admin|project)-accessibility/)
})

test('R50 候选负载目录树与文件集精确匹配白名单', () => {
  const expectedTree = [...EXPECTED_FILES, 'admin/', 'arrears/'].sort()
  assert.deepEqual(payloadTree(), expectedTree)
  assert.deepEqual(
    payloadTree().filter(entry => !entry.endsWith('/')),
    [...EXPECTED_FILES].sort(),
  )
})

test('R50 新覆盖层不访问网络、接口或认证上下文', () => {
  for (const relative of OVERLAY_FILES) {
    const source = read(relative)
    assert.doesNotMatch(source, /\bfetch\s*\(/i, `${relative} 不得发起 fetch`)
    assert.doesNotMatch(source, /\/api(?:\/|\b)/i, `${relative} 不得包含 API 路径`)
    assert.doesNotMatch(
      source,
      /\b(?:XMLHttpRequest|WebSocket|EventSource)\b|navigator\.sendBeacon/i,
      `${relative} 不得使用其他网络原语`,
    )
    assert.doesNotMatch(
      source,
      /\bAuthorization\b|cockpit_token|authToken/i,
      `${relative} 不得读取认证上下文`,
    )
  }
})

test('R50 候选不携带数据库、服务端或受保护业务数据资产', () => {
  for (const relative of EXPECTED_FILES) {
    assert.doesNotMatch(
      relative,
      /(^|\/)(?:api|backups?|data|db|drizzle|knowledge|private|secrets?|server|uploads?|worker)(?:\/|$)/i,
    )
    assert.doesNotMatch(
      relative,
      /\.(?:bak|csv|db|dump|env|json|key|ndjson|parquet|pem|sql|sqlite|sqlite3|xlsx?)$/i,
    )
    assert.match(relative, /\.(?:css|html|js)$/)
  }

  const payloadFiles = payloadTree().filter(entry => !entry.endsWith('/'))
  assert.equal(payloadFiles.some(file => file.includes('/assets/')), false)
  assert.equal(payloadFiles.some(file => file.startsWith('assets/')), false)
})
