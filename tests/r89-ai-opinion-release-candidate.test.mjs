import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const candidate = path.join(root, 'release-candidates', 'cockpit-r89-ai-opinion-20260816-194449')
const manifest = JSON.parse(await readFile(path.join(candidate, 'manifest.json'), 'utf8'))
const index = await readFile(path.join(candidate, 'payload/index.expected.html'), 'utf8')
const js = await readFile(path.join(candidate, 'payload/assets/cockpit-bundle-defer-20260816-r89-ai-opinion.js'), 'utf8')
const css = await readFile(path.join(candidate, 'payload/assets/cockpit-bundle-20260816-r89-ai-opinion.css'), 'utf8')

const sha256 = value => createHash('sha256').update(value).digest('hex')

test('R89候选精确绑定当前生产R88基线且未执行生产变更', () => {
  assert.equal(manifest.productionMutationPerformed, false)
  assert.equal(manifest.baseline.indexSha256, 'c2418baddd9ad9a2a932ee06275c80bbfdb3a84d5554da6471c9b7ecdc4600d6')
  assert.equal(manifest.baseline.deferSha256, '12b887949afb518629fc2260f37894519190f21cca9b52df9cd579131f34cd61')
  assert.equal(manifest.sourceReplacement.oldComponentSha256, manifest.baseline.assistantComponentSha256)
  assert.deepEqual(manifest.protectedRoutes, ['/daily', '/payment', '/collection'])
})

test('候选只切换defer与CSS入口并保留R80和R77应用入口', () => {
  assert.match(index, /cockpit-bundle-defer-20260816-r89-ai-opinion\.js\?v=r89-ai-opinion1/)
  assert.match(index, /cockpit-bundle-20260816-r89-ai-opinion\.css/)
  assert.doesNotMatch(index, /cockpit-bundle-defer-20260816\.js\?v=r88-knowledge-choices1/)
  assert.match(index, /aph2-r80-current-site-fixes-20260816-v1\.js/)
  assert.match(index, /cockpit-r77-region-wide-scope-20260813-v1\/app-G7HUEEER\.js/)
})

test('AI意见组件在候选bundle中恰好一份且没有修改业务API', () => {
  assert.equal((js.match(/function appendAiOpinion\(/g) || []).length, 1)
  assert.equal((js.match(/const ID = 'north-ai-assistant'/g) || []).length, 1)
  assert.match(js, /mainAnswerText\(text, meta\.aiOpinion\)/)
  assert.match(js, /AI意见用于经营分析和核查提示，不替代业务确认或审批结论/)
  assert.doesNotMatch(js.slice(manifest.sourceReplacement.start, manifest.sourceReplacement.start + manifest.sourceReplacement.newComponentBytes), /fetch\('\/api\/(?:daily|payments|collections)/)
})

test('AI意见样式严格限定助手范围并覆盖移动端和可访问性', () => {
  assert.match(css, /#north-ai-assistant \.north-ai-opinion/)
  assert.match(css, /min-height: 44px/)
  assert.match(css, /@media \(max-width: 640px\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.doesNotMatch(css, /(?:^|\n)\s*(?:body|main|\.payment|\.collection|\.daily)\s*[{,]/)
})

test('候选文件与manifest哈希完全一致', async () => {
  for (const file of manifest.files) {
    const contents = await readFile(path.join(candidate, file.path))
    assert.equal(contents.length, file.size, file.path)
    assert.equal(sha256(contents), file.sha256, file.path)
  }
})
