import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const release = 'cockpit-r89-ai-opinion-20260816-194449'
const candidate = path.join(root, 'release-candidates', release)
const payload = path.join(candidate, 'payload')
const sourceDir = path.join(candidate, 'source')

const expected = {
  indexSha256: 'c2418baddd9ad9a2a932ee06275c80bbfdb3a84d5554da6471c9b7ecdc4600d6',
  deferSha256: '12b887949afb518629fc2260f37894519190f21cca9b52df9cd579131f34cd61',
  cssSha256: '60348ce8af4f2b1f73b2e88c9f3ebe34ffb5884c67218ce2ef374b852609df2b',
  assistantComponentSha256: 'a9ca9212bacaa58b3dc01e506d650b9c5352473787c174483c9b676ef5b604b2',
}

const urls = {
  index: 'https://www.firstcare.cloud/',
  defer: 'https://www.firstcare.cloud/assets/cockpit-bundle-defer-20260816.js?v=r88-knowledge-choices1',
  css: 'https://www.firstcare.cloud/assets/cockpit-bundle-20260816.css',
}

const oldRefs = {
  defer: '/assets/cockpit-bundle-defer-20260816.js?v=r88-knowledge-choices1',
  css: '/assets/cockpit-bundle-20260816.css',
}

const newRefs = {
  defer: '/assets/cockpit-bundle-defer-20260816-r89-ai-opinion.js?v=r89-ai-opinion1',
  css: '/assets/cockpit-bundle-20260816-r89-ai-opinion.css',
}

const componentStart = "(() => {\n  'use strict'\n  const ID = 'north-ai-assistant'"
const componentEnd = '\n/* R50：AI 使用链路收口。只增强入口、门禁引导与可恢复状态，不改业务数据与 API。 */'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fetchBuffer(url) {
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) throw new Error(`${url} 返回 ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function assertHash(label, value, wanted) {
  const actual = sha256(value)
  if (actual !== wanted) throw new Error(`${label}哈希漂移：期望 ${wanted}，实际 ${actual}`)
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`${label}不是唯一匹配`)
  return source.slice(0, first) + after + source.slice(first + before.length)
}

await mkdir(candidate, { recursive: false })
await mkdir(payload, { recursive: false })
await mkdir(path.join(payload, 'assets'), { recursive: false })
await mkdir(sourceDir, { recursive: false })

const [productionIndexBuffer, productionDeferBuffer, productionCssBuffer] = await Promise.all([
  fetchBuffer(urls.index), fetchBuffer(urls.defer), fetchBuffer(urls.css),
])
assertHash('生产index', productionIndexBuffer, expected.indexSha256)
assertHash('生产defer bundle', productionDeferBuffer, expected.deferSha256)
assertHash('生产CSS bundle', productionCssBuffer, expected.cssSha256)

const productionIndex = productionIndexBuffer.toString('utf8')
const productionDefer = productionDeferBuffer.toString('utf8')
const productionCss = productionCssBuffer.toString('utf8')
const assistantSourcePath = path.join(root, 'firstcare-cloud-local', 'north-ai-assistant-20260813-r55.js')
const opinionCssPath = path.join(root, 'firstcare-cloud-local', 'aph2-r89-ai-opinion-20260816-v1.css')
const assistantSource = await readFile(assistantSourcePath, 'utf8')
const opinionCss = await readFile(opinionCssPath, 'utf8')

const start = productionDefer.indexOf(componentStart)
const end = productionDefer.indexOf(componentEnd, start)
if (start < 0 || end < 0 || productionDefer.indexOf(componentStart, start + 1) >= 0) throw new Error('生产助手组件边界不唯一')
const oldAssistant = productionDefer.slice(start, end)
assertHash('生产助手组件', oldAssistant, expected.assistantComponentSha256)
if (oldAssistant.includes('appendAiOpinion')) throw new Error('生产助手已包含AI意见，候选基线失效')
if (!assistantSource.includes('appendAiOpinion') || !assistantSource.includes('meta.aiOpinion')) throw new Error('本地助手源缺少AI意见实现')

const replacement = `${assistantSource.trimEnd()};`
const nextDefer = `${productionDefer.slice(0, start)}${replacement}${productionDefer.slice(end)}`
const nextCss = `${productionCss.trimEnd()}\n${opinionCss.trim()}\n`
let nextIndex = replaceOnce(productionIndex, oldRefs.defer, newRefs.defer, 'defer入口')
nextIndex = replaceOnce(nextIndex, oldRefs.css, newRefs.css, 'CSS入口')

const files = {
  'payload/index.expected.html': Buffer.from(nextIndex),
  'payload/assets/cockpit-bundle-defer-20260816-r89-ai-opinion.js': Buffer.from(nextDefer),
  'payload/assets/cockpit-bundle-20260816-r89-ai-opinion.css': Buffer.from(nextCss),
  'source/north-ai-assistant-20260813-r55.js': Buffer.from(assistantSource),
  'source/aph2-r89-ai-opinion-20260816-v1.css': Buffer.from(opinionCss),
}

for (const [relative, contents] of Object.entries(files)) {
  await writeFile(path.join(candidate, relative), contents)
}

const manifest = {
  release,
  createdAt: new Date().toISOString(),
  productionMutationPerformed: false,
  baseline: {
    origin: urls.index,
    ...expected,
    oldRefs,
  },
  nextRefs: newRefs,
  sourceReplacement: {
    start,
    end,
    oldComponentBytes: Buffer.byteLength(oldAssistant),
    oldComponentSha256: sha256(oldAssistant),
    newComponentBytes: Buffer.byteLength(replacement),
    newComponentSha256: sha256(replacement),
  },
  protectedRoutes: ['/daily', '/payment', '/collection'],
  files: Object.entries(files).map(([relative, contents]) => ({
    path: relative,
    size: contents.length,
    sha256: sha256(contents),
  })),
}
await writeFile(path.join(candidate, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const sums = [...manifest.files, {
  path: 'manifest.json',
  size: Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`),
  sha256: sha256(`${JSON.stringify(manifest, null, 2)}\n`),
}].map(file => `${file.sha256}  ${file.path}`).join('\n')
await writeFile(path.join(candidate, 'SHA256SUMS'), `${sums}\n`)

console.log(JSON.stringify({
  release,
  candidate,
  indexSha256: sha256(nextIndex),
  deferSha256: sha256(nextDefer),
  cssSha256: sha256(nextCss),
  productionMutationPerformed: false,
}, null, 2))
