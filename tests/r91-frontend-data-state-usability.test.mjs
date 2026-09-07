import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'firstcare-cloud-local/aph2-r91-frontend-data-state-20260817-v1.js')
const cssPath = path.join(root, 'firstcare-cloud-local/aph2-r91-frontend-data-state-20260817-v1.css')
const builderPath = path.join(root, 'scripts/build-r91-frontend-data-state-candidate.mjs')

function loadContract() {
  assert.equal(fs.existsSync(sourcePath), true, 'R91前端状态模块必须存在')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const window = {}
  vm.runInNewContext(source, { window, console, URL, setTimeout, clearTimeout })
  assert.ok(window.__cockpitFrontendDataState, 'R91必须公开冻结的纯状态契约供回归测试')
  return { contract: window.__cockpitFrontendDataState, source }
}

test('R91严格区分正式、未发布、陈旧、部分可用和未知来源', () => {
  const { contract } = loadContract()
  assert.deepEqual(
    { ...contract.classifySource('aph', { status: 'ready', businessDate: '2026-08-17' }) },
    { state: 'ready', label: '正式来源可用', tone: 'success' },
  )
  assert.deepEqual(
    { ...contract.classifySource('lvzai', { status: 'ready', publicationStatus: 'staged' }) },
    { state: 'unpublished', label: '尚未正式发布', tone: 'warning' },
  )
  assert.deepEqual(
    { ...contract.classifySource('lvzai', { status: 'ready', publicationStatus: 'published' }) },
    { state: 'ready', label: '正式来源可用', tone: 'success' },
  )
  assert.equal(contract.classifySource('aph', { status: 'stale' }).state, 'stale')
  assert.equal(contract.classifySource('aph', { status: 'partial' }).state, 'partial')
  assert.equal(contract.classifySource('aph', { status: 'unexpected-value' }).state, 'unavailable')
})

test('R91缺失值显示破折号且离散计数不补0、不显示undefined、不接受小数', () => {
  const { contract } = loadContract()
  assert.equal(contract.formatCount(null), '—')
  assert.equal(contract.formatCount(undefined), '—')
  assert.equal(contract.formatCount(''), '—')
  assert.equal(contract.formatCount(0), '0')
  assert.equal(contract.formatCount(35), '35')
  assert.equal(contract.formatCount(35.5), '—')
  assert.equal(contract.formatBusinessDate(null), '业务日期 —')
})

test('R91视图模型覆盖加载、空数据、失败、无权限、陈旧和正式状态', () => {
  const { contract } = loadContract()
  const normalize = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(
    normalize(contract.createViewModel({ kind: 'loading' })),
    {
      kind: 'loading',
      title: '正在核验数据依据',
      summary: '正在读取正式来源与发布状态',
      live: '经营数据依据正在加载',
      retryable: false,
      busy: true,
      sources: [],
      policy: '',
    },
  )
  assert.equal(contract.createViewModel({ kind: 'unauthorized', status: 401 }).title, '登录状态已失效')
  assert.equal(contract.createViewModel({ kind: 'forbidden', status: 403 }).title, '无权查看数据依据')
  assert.equal(contract.createViewModel({ kind: 'error', status: 502 }).retryable, true)

  const empty = contract.createViewModel({
    kind: 'data',
    payload: { status: 'unavailable', sources: {}, presentationPolicy: { showProjectOperatingMetrics: false } },
  })
  assert.equal(empty.kind, 'empty')
  assert.match(empty.summary, /暂无已验证的正式来源/)
  assert.match(empty.policy, /当前系统不接入/)

  const stale = contract.createViewModel({
    kind: 'data',
    payload: {
      status: 'partial',
      sources: {
        aph: { status: 'stale', businessDate: '2026-08-05' },
        lvzai: { status: 'ready', publicationStatus: 'staged', businessDate: '2026-08-05' },
      },
      presentationPolicy: { showProjectOperatingMetrics: false },
    },
  })
  assert.equal(stale.kind, 'warning')
  assert.match(stale.summary, /不可作为当前正式经营事实/)
  assert.equal(stale.sources[0].status.state, 'stale')
  assert.equal(stale.sources[1].status.state, 'unpublished')

  const ready = contract.createViewModel({
    kind: 'data',
    payload: {
      status: 'ready',
      sources: {
        aph: { status: 'ready', businessDate: '2026-08-17', paymentCenterCount: 6, verifiedDailyCenterCount: 6 },
        lvzai: { status: 'ready', publicationStatus: 'published', businessDate: '2026-08-17', centerCount: 35 },
      },
      presentationPolicy: { showProjectOperatingMetrics: false, excludedValueLabel: '当前系统不接入' },
    },
  })
  assert.equal(ready.kind, 'ready')
  assert.equal(ready.sources[0].detail, '回款中心 6 个；每日数据已验证 6 个中心')
  assert.equal(ready.sources[1].detail, '当前权限范围 35 个服务中心；发布状态 已发布')
})

test('R91保护已验收路由、避免演示数据与客户端公式并处理异步竞态', () => {
  const { contract, source } = loadContract()
  for (const route of ['/daily', '/payment', '/collection']) assert.equal(contract.isActiveRoute(route), false)
  for (const route of ['/', '/command', '/projects', '/ai-report', '/ai-alerts']) assert.equal(contract.isActiveRoute(route), true)
  assert.doesNotMatch(source, /Math\.random|演示数据|mock/i)
  assert.doesNotMatch(source, /received\s*\/\s*receivable|Math\.max\([^)]*receivable/i)
  assert.match(source, /const currentRequest = \+\+requestId/)
  assert.match(source, /currentRequest !== requestId \|\| currentRoute !== route\(\)/)
  assert.match(source, /response\.status === 401/)
  assert.match(source, /response\.status === 403/)
  assert.match(source, /aria-live/)
  assert.match(source, /aria-busy/)
})

test('R91每次刷新先失效旧请求与旧能力快照，延迟挂载也不得覆盖新状态', () => {
  const { source } = loadContract()
  const refreshBody = source.slice(source.indexOf('async function refresh()'), source.indexOf('\n  refresh()'))
  assert.ok(
    refreshBody.indexOf('const currentRequest = ++requestId') < refreshBody.indexOf('const bearer = token()'),
    '令牌缺失或变化时也必须先令旧请求失效',
  )
  assert.match(source, /delete window\.__cockpitOperatingCapabilities/)
  assert.match(source, /function renderWhenReady\(model, attempts, expectedRequest, expectedRoute\)/)
  assert.match(source, /expectedRequest !== requestId \|\| expectedRoute !== route\(\)/)
  assert.match(source, /window\.addEventListener\('aph:r45-integrated-mounted', refresh\)/)
})

test('R91样式提供键盘焦点、窄屏单列、触控尺寸和减少动态效果支持', () => {
  assert.equal(fs.existsSync(cssPath), true, 'R91样式必须存在')
  const css = fs.readFileSync(cssPath, 'utf8')
  assert.match(css, /:focus-visible/)
  assert.match(css, /@media \(max-width: 640px\)/)
  assert.match(css, /grid-template-columns:\s*1fr/)
  assert.match(css, /min-height:\s*44px/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
})

test('R91候选构建只替换R90状态模块并保留生产基线其余入口', async () => {
  assert.equal(fs.existsSync(builderPath), true, 'R91候选构建器必须存在')
  const { buildCandidateIndex } = await import(`${pathToFileURL(builderPath).href}?test=${Date.now()}`)
  const baseline = '<html><head><script src="/assets/cockpit-bundle-head-20260816.js"></script><link rel="stylesheet" href="/aph2-r90-operating-capabilities-20260816-v1.css?v=r90-capabilities1"></head><body><div id="root"></div><script src="/aph2-r90-operating-capabilities-20260816-v1.js?v=r90-capabilities1" defer></script></body></html>'
  const candidate = buildCandidateIndex(baseline)
  assert.match(candidate, /cockpit-bundle-head-20260816\.js/)
  assert.doesNotMatch(candidate, /aph2-r90-operating-capabilities/)
  assert.equal(candidate.split('/aph2-r91-frontend-data-state-20260817-v1.js?v=r91-data-state1').length - 1, 1)
  assert.equal(candidate.split('/aph2-r91-frontend-data-state-20260817-v1.css?v=r91-data-state1').length - 1, 1)
})
