import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const site = path.join(root, 'firstcare-cloud-local')
const read = relativePath => fs.readFileSync(path.join(site, relativePath), 'utf8')

const css = read('aph2-r63-no-header-explainers-20260813-v3.css')
const legacyCssV1 = read('aph2-r63-no-header-explainers-20260813-v1.css')
const legacyCssV2 = read('aph2-r63-no-header-explainers-20260813-v2.css')
const truthEnhancer = read('aph2-r34-full-frontend-remediation-20260812-v1.js')
const serviceCenterCss = read('aph2-r56-ai-service-centers-20260812-v1.css')
const adminBundle = read('admin/assets/index-BGiu0CJR.js')
const entries = {
  root: read('index.html'),
  admin: read('admin/index.html'),
  system: read('system/index.html'),
  arrears: read('arrears/index.html'),
}

const cssAsset = '/aph2-r63-no-header-explainers-20260813-v3.css?v=r63-header-clean3'
const legacyCssAssets = [
  '/aph2-r63-no-header-explainers-20260813-v1.css?v=r63-header-clean1',
  '/aph2-r63-no-header-explainers-20260813-v2.css?v=r63-header-clean2',
]

function activeApplication() {
  const preloadMatch = entries.root.match(
    /<link\s+rel="modulepreload"\s+href="(\/assets\/([^"/]+)\/app-[^"]+\.js)">/,
  )
  const bootstrapMatch = entries.root.match(
    /<script\s+type="module"\s+crossorigin\s+src="(\/[^"?]+app-bootstrap[^"?]+\.js)\?[^\"]+"><\/script>/,
  )
  assert.ok(preloadMatch, '根入口必须有唯一活跃应用预加载')
  assert.ok(bootstrapMatch, '根入口必须有唯一活跃启动器')

  const preload = preloadMatch[1]
  const bundle = preloadMatch[2]
  const bootstrapAsset = bootstrapMatch[1]
  return {
    preload,
    bundle,
    bootstrapAsset,
    bootstrap: read(bootstrapAsset.slice(1)),
    shell: read(`assets/${bundle}/chunk-4UXV2DAK.js`),
  }
}

test('R63 v3 在根、后台、系统和欠费四个入口替换 v1/v2 并后置加载', () => {
  const previousAssets = {
    root: 'aph2-r59-sidebar-content-safe-area-20260813-v1.css',
    admin: 'aph2-r61-admin-table-continuity-20260813-v1.css',
    system: 'system-management-20260811-v4.css',
    arrears: 'aph2-r62-arrears-direct-ai-20260813-v1.css',
  }

  for (const [name, html] of Object.entries(entries)) {
    assert.equal(
      html.split(cssAsset).length - 1,
      1,
      `${name} 入口必须且只能引用一次 R63 v3 CSS`,
    )
    for (const legacyCssAsset of legacyCssAssets) {
      assert.equal(html.includes(legacyCssAsset), false, `${name} 入口不得继续引用旧 R63 CSS`)
    }
    assert.ok(html.indexOf(cssAsset) > html.indexOf(previousAssets[name]))
    assert.ok(html.indexOf(cssAsset) < html.indexOf('</head>'))
  }
})

test('R63 标题契约跟随当前活跃应用包，不被后续 R64/R65 发布误判为丢失', () => {
  const active = activeApplication()

  assert.equal(entries.root.split(active.preload).length - 1, 1)
  assert.equal(entries.root.split(active.bootstrapAsset).length - 1, 1)
  assert.ok(active.bootstrap.includes(`await import('${active.preload}')`))

  assert.ok(
    active.shell.includes('i && /^\\/projects\\/[^\\/]+$/.test(r.split("?")[0]) && $.jsx("div"'),
    '公共 subtitle 只允许在单个项目详情中作为对象身份元数据展示',
  )
  assert.doesNotMatch(
    active.shell,
    /i\s*&&\s*\$\.jsx\("div",\s*\{\s*className:\s*"truncate text-\[13px\] text-muted-foreground"/,
  )
})

test('R63 v3 只隐藏主驾驶舱标题说明和历史重复提示', () => {
  for (const selector of [
    '#main-content > .aph-real-data-scope',
    '#main-content > .aph-r34-tasks-notice',
    '.aph-project-profile-page > .aph-project-page-head > div:first-child > p',
    '[data-r56-ai-center-app] .r56-eyebrow',
    '[data-r56-ai-center-app] .r56-page-intro',
  ]) {
    assert.ok(css.includes(selector), `缺少主驾驶舱精准选择器：${selector}`)
  }
})

test('R63 v3 对 R56 只隐藏英文眉题和标题长说明', () => {
  const r56Selectors = [...css.matchAll(
    /body\.aph2-theme\s+\[data-r56-ai-center-app\]\s+([^,{\n]+)/g,
  )].map(match => match[1].trim())

  assert.deepEqual(r56Selectors, ['.r56-eyebrow', '.r56-page-intro'])
  for (const preservedSelector of [
    '.r56-context',
    '.r56-summary-grid',
    '.r56-center-list',
    '.r56-evidence',
    '[role="alert"]',
  ]) {
    assert.equal(css.includes(`[data-r56-ai-center-app] ${preservedSelector}`), false)
  }
})

test('R63 v3 精准隐藏后台、系统和欠费页的标题区说明', () => {
  for (const selector of [
    '.page-title > div:first-child > .eyebrow',
    '.page-title > div:first-child > p:last-child:not(:only-child)',
    '.system-topbar > p',
    '.system-intro > div > p',
    '.aph-shell-header > .aph-shell-status',
    'main#main-content > .page-heading > div:first-child > .eyebrow',
    'main#main-content > .page-heading > div:first-child > p',
  ]) {
    assert.ok(css.includes(selector), `缺少独立入口精准选择器：${selector}`)
  }
})

test('R63 v3 不隐藏真实性状态容器和 strong，仅精简其直接说明段', () => {
  assert.ok(legacyCssV1.includes('#main-content > .aph-r34-truth-summary'))
  assert.equal(legacyCssV2.includes('#main-content > .aph-r34-truth-summary'), false)
  assert.equal(css.includes('#main-content > .aph-r34-truth-summary'), false)
  assert.match(
    css,
    /body\.aph2-theme\s+#main-content\s+\.aph-r34-truth-summary\s*>\s*p\s*\{\s*display:\s*none\s*!important;?\s*\}/,
  )

  const hiddenBlocks = [...css.matchAll(/([^{}]+)\{[^{}]*display:\s*none\s*!important;?[^{}]*\}/g)]
    .map(match => match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim())
  const truthBlocks = hiddenBlocks.filter(selectors => selectors.includes('.aph-r34-truth-summary'))
  assert.deepEqual(
    truthBlocks,
    ['body.aph2-theme #main-content .aph-r34-truth-summary > p'],
    '真实性状态只能精简直接说明段，不得隐藏容器或 strong 状态',
  )
  assert.doesNotMatch(css, /\.aph-r34-truth-summary\s*>\s*(?:strong|\*)/)
})

test('R56 在新 56 中心页仅停用重复 legacy 门禁，R63 不强行恢复', () => {
  const serviceCenterChunk = read(`assets/${activeApplication().bundle}/chunk-IWVMRTJI.js`)
  assert.match(truthEnhancer, /if \(!\['\/arrears', '\/ai-alerts'\]\.includes\(window\.location\.pathname\)\) return/)
  assert.match(truthEnhancer, /summary\.className = 'aph-r34-truth-summary'/)
  assert.match(truthEnhancer, /<strong>经营指标待正式批次发布<\/strong><p>/)
  assert.match(
    serviceCenterCss,
    /body\[data-r42-route="ai-alerts"\]:has\(\[data-r56-ai-center-app\]\)\s*:is\([\s\S]*\.aph-r34-truth-summary[\s\S]*\)\s*\{\s*display:\s*none\s*!important/,
  )
  for (const status of ['业务日期', '整体可信度', '数据口径']) {
    assert.ok(serviceCenterChunk.includes(status), `新 56 中心页缺少状态：${status}`)
  }
  assert.doesNotMatch(css, /\.aph-r34-truth-summary\s*\{[^}]*display:\s*(?:grid|block|flex)\s*!important/)
})

test('R63 v3 不使用全局段落隐藏，业务错误、门禁和详情说明继续可见', () => {
  for (const forbiddenSelector of [
    'main p',
    'header p',
    '.page-title p',
    '.page-heading p',
    '.guardrail',
    '.system-note',
    '.entry-card p',
    '.r55-error-panel',
    '.r55-validation-panel',
    '.r55-section-heading',
    '.r55-review-header',
    '.quality-note',
    '[role="alert"]',
    '.modal',
  ]) {
    assert.equal(
      css.includes(forbiddenSelector),
      false,
      `R63 不得隐藏业务证据或宽泛段落：${forbiddenSelector}`,
    )
  }

  for (const preservedMarkup of [
    'class="guardrail"',
    'class="r55-error-panel"',
    'class="r55-validation-panel"',
    'class="r55-section-heading"',
    'class="r55-review-header"',
    'class="quality-note"',
  ]) {
    assert.ok(entries.arrears.includes(preservedMarkup), `欠费业务证据结构丢失：${preservedMarkup}`)
  }

  assert.ok(entries.system.includes('class="system-note"'))
  assert.ok(entries.system.includes('class="entry-card usage-card"'))
  assert.ok(adminBundle.includes('className:"alert danger"'))
  assert.ok(adminBundle.includes('className:"modal-backdrop"'))
})
