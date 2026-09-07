import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const candidate = path.join(root, 'release-candidates', 'cockpit-r90-operating-capabilities-20260816-204727')
const manifest = JSON.parse(await readFile(path.join(candidate, 'manifest.json'), 'utf8'))
const index = await readFile(path.join(candidate, 'payload/index.expected.html'), 'utf8')
const js = await readFile(path.join(candidate, 'payload/aph2-r90-operating-capabilities-20260816-v1.js'), 'utf8')
const serverIndex = await readFile(path.join(candidate, 'server-dist/index.js'), 'utf8')
const serverRoute = await readFile(path.join(candidate, 'server-dist/routes/operating-capabilities.js'), 'utf8')
const serverSourceRoute = await readFile(path.join(candidate, 'server-src/src/routes/operating-capabilities.ts'), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')

test('R90候选绑定当前R89生产基线且未执行生产变更', () => {
  assert.equal(manifest.productionMutationPerformed, false)
  assert.equal(manifest.baseline.release, 'cockpit-r89-ai-opinion-20260816-194449')
  assert.equal(manifest.baseline.indexSha256, 'b7c88d6888f4eef9cefd28225199cd64c01110175cffebd650385c91c0d16c8b')
  assert.deepEqual(manifest.protectedRoutes, ['/daily', '/payment', '/collection'])
})

test('R90只新增独立能力模块并保留R89入口', () => {
  assert.equal(index.split(manifest.refs.script).length - 1, 1)
  assert.equal(index.split(manifest.refs.stylesheet).length - 1, 1)
  assert.match(index, /cockpit-bundle-defer-20260816-r89-ai-opinion\.js\?v=r89-ai-opinion1/)
  assert.match(index, /cockpit-bundle-20260816-r89-ai-opinion\.css/)
  assert.match(index, /aph2-r80-current-site-fixes-20260816-v1\.js/)
})

test('R90候选包含浏览器运行所需的本地R80、R77、图标与生产bundle', async () => {
  for (const relative of [
    'payload/assets/cockpit-bundle-head-20260816.js',
    'payload/assets/cockpit-bundle-defer-20260816-r89-ai-opinion.js',
    'payload/assets/cockpit-bundle-20260816-r89-ai-opinion.css',
    'payload/assets/cockpit-r77-region-wide-scope-20260813-v1/app-G7HUEEER.js',
    'payload/assets/dashboard-DTaY1fJn.js',
    'payload/assets/command-center-wWI18QJ1.js',
    'payload/assets/projects-XhDVt86_.js',
    'payload/assets/ai-report-BRARTgii.js',
    'payload/assets/ai-alerts-B98lf7_A.js',
    'payload/aph2-r77-app-bootstrap-20260813-v1.js',
    'payload/aph2-r56-ai-service-centers-20260812-v1.css',
    'payload/aph2-r80-current-site-fixes-20260816-v1.js',
    'payload/aph2-r80-current-site-fixes-20260816-v1.css',
    'payload/aph-icons/shouyeF.png',
    'payload/logo.png',
  ]) await readFile(path.join(candidate, relative))
})

test('R90前端只读取能力接口且明确保护三个已验收路由', () => {
  assert.match(js, /fetch\('\/api\/operating-capabilities'/)
  assert.match(js, /当前系统不接入/)
  for (const route of manifest.protectedRoutes) assert.match(js, new RegExp(route.replace('/', '\\/')))
  assert.doesNotMatch(js, /fetch\('\/api\/(?:daily|payments|collections)/)
})

test('R90后端候选包含认证后的只读能力路由', () => {
  assert.match(serverIndex, /app\.use\(operatingCapabilitiesRouter\)/)
  assert.match(serverRoute, /router\.get\('\/api\/operating-capabilities'/)
  assert.doesNotMatch(serverRoute, /INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|\.run\(/i)
  assert.match(serverSourceRoute, /router\.get\('\/api\/operating-capabilities'/)
  assert.equal(manifest.backendSourceFiles.length, 9)
})

test('R90候选文件与manifest哈希完全一致', async () => {
  for (const file of manifest.files) {
    const contents = await readFile(path.join(candidate, file.path))
    assert.equal(contents.length, file.size, file.path)
    assert.equal(hash(contents), file.sha256, file.path)
  }
})
