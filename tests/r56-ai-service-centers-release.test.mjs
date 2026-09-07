import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const site = path.join(root, 'firstcare-cloud-local')

function resolvedPath(environmentKey, fallback) {
  const configured = process.env[environmentKey]
  return configured ? path.resolve(configured) : fallback
}

const releaseName = process.env.R56_AI_RELEASE_NAME || 'cockpit-r56-ai-service-center-20260812-v1'
const candidateDir = resolvedPath(
  'R56_AI_ASSET_DIR',
  path.join(site, 'assets', releaseName),
)
const baseDir = resolvedPath(
  'R56_AI_BASE_ASSET_DIR',
  path.join(site, 'assets', 'cockpit-r51-cloud-remediation-20260812-v1'),
)
const routeChunk = resolvedPath(
  'R56_AI_JS_PATH',
  path.join(candidateDir, 'chunk-IWVMRTJI.js'),
)
const stylesheet = resolvedPath(
  'R56_AI_CSS_PATH',
  path.join(site, 'aph2-r56-ai-service-centers-20260812-v1.css'),
)
const serverRoute = resolvedPath(
  'R56_AI_SERVER_PATH',
  path.join(root, 'server', 'src', 'routes', 'ai.ts'),
)
const analysisModule = resolvedPath(
  'R56_AI_ANALYSIS_PATH',
  path.join(root, 'server', 'src', 'service-center-analysis.ts'),
)
const bootstrap = resolvedPath(
  'R56_AI_BOOTSTRAP_PATH',
  path.join(site, 'aph2-r56-app-bootstrap-20260812-v1.js'),
)
const htmlPath = resolvedPath('R56_AI_HTML_PATH', path.join(site, 'index.html'))

function read(file) {
  assert.ok(fs.existsSync(file), `缺少文件：${file}`)
  return fs.readFileSync(file, 'utf8')
}

function referencedLocalScripts(html) {
  const files = []
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    const source = match[1].split(/[?#]/, 1)[0]
    if (!source.startsWith('/')) continue
    const file = path.join(site, source.slice(1))
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file)
  }
  return files
}

function filesBelow(directory, prefix = '') {
  const output = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) output.push(...filesBelow(path.join(directory, entry.name), relative))
    else if (entry.isFile()) output.push(relative)
  }
  return output.sort()
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function routeHandlerBlock(source, route) {
  const markers = [`router.get('${route}'`, `router.get("${route}"`]
  const start = Math.max(...markers.map((marker) => source.indexOf(marker)))
  assert.notEqual(start, -1, `未找到 GET ${route}`)
  const next = source.indexOf('\nrouter.', start + 12)
  return source.slice(start, next === -1 ? source.length : next)
}

const html = read(htmlPath)
const js = read(routeChunk)
const css = read(stylesheet)
const server = read(serverRoute)
const analysis = read(analysisModule)

test('R56 激活新的不可变 AI 路由资产和根样式', () => {
  const startupFiles = referencedLocalScripts(html)
  const startupSource = [html, read(bootstrap), ...startupFiles.map(read)].join('\n')
  assert.match(startupSource, new RegExp(`/assets/${releaseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/app-G7HUEEER\\.js`))
  assert.match(js, /R56_ENDPOINT\s*=\s*["']\/api\/ai\/service-centers["']/)
  assert.match(js, /aph2-r56-ai-service-centers-20260812-v1\.css/)
  assert.match(css, /\[data-r56-ai-center-app\]/)
})

test('R56 AI 页只读取新服务中心接口，不再请求旧预警或任务接口', () => {
  assert.match(js, /Jd\(R56_ENDPOINT/)
  assert.doesNotMatch(js, /["']\/api\/alerts(?:[/?"'])/)
  assert.doesNotMatch(js, /["']\/api\/tasks(?:[/?"'])/)
  assert.doesNotMatch(js, /method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i)
})

test('R56 后端以授权 payment_centers 为全集，返回状态、缺失性和证据契约', () => {
  const handler = routeHandlerBlock(server, '/api/ai/service-centers')
  const contractSource = `${handler}\n${analysis}`
  assert.match(handler, /payment_centers/)
  assert.match(handler, /aggregateAreaScopeForUser|area_scope|allowedAreas/)
  assert.match(contractSource, /businessDate/)
  assert.match(contractSource, /publicationStatus/)
  assert.match(contractSource, /scope/)
  assert.match(contractSource, /summary/)
  assert.match(contractSource, /rows/)
  for (const field of [
    'operatingStatus', 'dataStatus', 'analysis', 'recommendations',
    'metrics', 'availability', 'signals', 'evidence',
  ]) {
    assert.match(contractSource, new RegExp(`\\b${field}\\b`), `缺少字段 ${field}`)
  }
  for (const evidenceField of ['source', 'businessDate', 'lastValidatedAt', 'methodology', 'rule']) {
    assert.match(contractSource, new RegExp(`\\b${evidenceField}\\b`), `缺少证据字段 ${evidenceField}`)
  }
  assert.match(contractSource, /credibility/)
  assert.match(contractSource, /coverage/)
  assert.match(contractSource, /dataIncomplete/)
  assert.doesNotMatch(handler, /res\.status\(2\d\d\).*\.(?:insert|update|delete|run)\(/is)
})

test('R56 前端明确保留 null 为“未接入”，并使用 dataStatus/operatingStatus', () => {
  assert.match(js, /value === void 0 \|\| value === null/)
  assert.match(js, /未接入/)
  assert.match(js, /row\.operatingStatus/)
  assert.match(js, /row\.dataStatus/)
  assert.match(js, /summary\.dataPartial/)
  assert.match(js, /summary\.dataMissing/)
  assert.match(js, /dailyCollection:\s*["']当日回款["']/)
  assert.doesNotMatch(js, /dailyCollection:\s*["']今日回款["']/)
  assert.doesNotMatch(js, /(?:metric|value|rate|budget|executed)\s*\|\|\s*0/i)
})

test('R56 极简界面契约包含 3 个摘要、筛选、56 中心行和可展开证据', () => {
  assert.match(js, /data-r56-ai-center-app/)
  assert.equal((js.match(/data-r56-summary["']:\s*tone/g) || []).length, 1)
  assert.match(js, /服务中心总数/)
  assert.match(js, /需关注/)
  assert.match(js, /数据待补齐/)
  assert.match(js, /data-r56-filter/)
  assert.match(js, /data-r56-center-row/)
  assert.match(js, /data-r56-center-toggle/)
  assert.match(js, /data-r56-center-evidence/)
  assert.match(js, /return \$\.jsxs\(["']details["']/)
  assert.match(js, /\$\.jsxs\(["']summary["']/)
  assert.match(js, /证据来源/)
  assert.match(js, /当前显示/)
  assert.match(js, /model\s*\?\s*`\$\{model\.total\}个服务中心，逐一给出经营判断`/)
  assert.doesNotMatch(js, /subtitle:\s*["']56个APH回款中心经营分析["']/)
})

test('R56 样式包含桌面/移动响应式、键盘焦点和减少动效保护', () => {
  assert.match(css, /@media\s*\([^)]*max-width\s*:\s*\d+px/)
  assert.match(css, /:focus-visible/)
  const toggleRule = css.match(/\.r56-center-toggle\s*\{[^}]+\}/s)?.[0] || ''
  const minimumHeight = Number(toggleRule.match(/min-height\s*:\s*(\d+)px/)?.[1] || 0)
  assert.ok(minimumHeight >= 44, `中心展开操作应至少44px，实际${minimumHeight}px`)
  assert.match(css, /prefers-reduced-motion\s*:\s*reduce/)
  assert.match(css, /overflow-wrap\s*:\s*anywhere|word-break\s*:\s*break-word/)
})

test('R56 候选仅更换 AI 路由 chunk，保护 daily/payment/collection 其他资产', () => {
  assert.ok(fs.existsSync(baseDir), `缺少基线资产目录：${baseDir}`)
  const candidateFiles = filesBelow(candidateDir)
  const baseFiles = filesBelow(baseDir)
  assert.deepEqual(candidateFiles, baseFiles, '候选资产文件集应与基线一致')

  const allowedChanges = new Set(['chunk-IWVMRTJI.js'])
  const changed = candidateFiles.filter((relative) => (
    digest(path.join(candidateDir, relative)) !== digest(path.join(baseDir, relative))
  ))
  assert.deepEqual(changed, [...allowedChanges], `发现超出 AI 路由的资产变更：${changed.join(', ')}`)
})
