import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arrears = path.join(root, 'firstcare-cloud-local', 'arrears')
const html = fs.readFileSync(path.join(arrears, 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(arrears, 'aph2-r65-arrears-optional-conclusion-20260813-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(arrears, 'aph2-r65-arrears-optional-conclusion-20260813-v1.css'), 'utf8')

function occurrences(source, value) {
  return source.split(value).length - 1
}

function inputTag(id) {
  const match = html.match(new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`, 'i'))
  assert.ok(match, `缺少输入项 #${id}`)
  return match[0]
}

test('R65 以不可变资产在 R62 后单次加载', () => {
  const cssAsset = '/arrears/aph2-r65-arrears-optional-conclusion-20260813-v1.css?v=r65-arrears-optional-conclusion1'
  const jsAsset = '/arrears/aph2-r65-arrears-optional-conclusion-20260813-v1.js?v=r65-arrears-optional-conclusion1'
  assert.equal(occurrences(html, cssAsset), 1)
  assert.equal(occurrences(html, jsAsset), 1)
  assert.ok(html.indexOf(cssAsset) > html.indexOf('aph2-r62-arrears-direct-ai-20260813-v1.css'))
  assert.ok(html.indexOf(jsAsset) > html.indexOf('aph2-r62-arrears-direct-ai-20260813-v1.js'))
  assert.match(js, /dataset\.r65ArrearsConclusion = 'true'/)
})

test('欠费台账仍必填，沟通文件在新旧入口均明确选填', () => {
  assert.match(inputTag('r55LedgerFile'), /\srequired(?:\s|\/?>)/i)
  assert.match(inputTag('ledgerFile'), /\srequired(?:\s|\/?>)/i)
  assert.doesNotMatch(inputTag('r55CommunicationFile'), /\srequired(?:\s|\/?>)/i)
  assert.doesNotMatch(inputTag('communicationFile'), /\srequired(?:\s|\/?>)/i)
  assert.match(html, />企小码沟通记录（选填）<input id="r55CommunicationFile"/)
  assert.match(html, /未提供时仅按欠费台账事实分析/)
  assert.match(js, /input\.required = false/)
  assert.match(js, /input\.removeAttribute\('required'\)/)
})

test('R65 在 multipart 边界仅删除缺失的沟通字段，不伪造文件', () => {
  assert.match(js, /url\.pathname !== '\/api\/arrears\/batches'/)
  assert.match(js, /communication instanceof File/)
  assert.match(js, /if \(!isRealFile\) body\.delete\('communications'\)/)
  assert.doesNotMatch(js, /new File\s*\(|new Blob\s*\(/)
  assert.doesNotMatch(js, /body\.delete\('ledger'\)/)
})

test('R65 只读取整批结论 DTO，不用当前页 rows 冒充全量', () => {
  assert.match(js, /body\?\.conclusion \?\? body\?\.batch\?\.conclusion/)
  assert.match(js, /\/api\/arrears\/batches\/\$\{batchId\}\/conclusion/)
  assert.match(js, /dataset\.source = 'whole-batch'/)
  assert.match(js, /source\.headline/)
  assert.match(js, /source\.summary/)
  assert.match(js, /value\?\.available === false/)
  assert.match(js, /slice\(0, 4\)/)
  assert.doesNotMatch(js, /body\?*\.rows|body\[['"]rows['"]\]|\.rows\.reduce|\.rows\.map/)
  assert.match(js, /无整批结论时保持隐藏，不回退到分页结果拼接/)
})

test('R65 仅在 AI 完成态显示，重新分析和关闭工作区立即隐藏', () => {
  for (const status of ['parsed', 'running', 'analyzing', 'partial', 'failed', 'revoked', 'blocked']) {
    assert.match(js, new RegExp(`'${status}'`), `缺少未完成态：${status}`)
  }
  for (const status of ['analyzed', 'completed', 'complete']) {
    assert.match(js, new RegExp(`'${status}'`), `缺少完成态：${status}`)
  }
  assert.match(js, /if \(context\?\.active_run_id \|\| context\?\.activeRunId\) return false/)
  assert.match(js, /analysisStatus\.complete === false\) return false/)
  assert.match(js, /aiSignals\.available === false\) return false/)
  assert.match(js, /method === 'POST' && analyzeMatch\) hideConclusion\(\)/)
  assert.match(js, /if \(workspace\.hidden\) hideConclusion\(\)/)
})

test('R65 结论保持一条主结论、最多四个事实和固定人工边界', () => {
  assert.match(js, /section\.id = 'r65AiConclusion'/)
  assert.match(js, /createElement\('p', 'r65-conclusion-main'\)/)
  assert.match(js, /createElement\('ul', 'r65-conclusion-facts'\)/)
  assert.match(js, /待人工复核 · AI分析仅提供经营线索/)
  assert.match(js, /header\.after\(section\)/)
  assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|eval\s*\(|new Function/)
})

test('R65 为单列结论而非卡片网格，并覆盖移动端和可达性', () => {
  assert.match(css, /\.r65-ai-conclusion\s*\{/)
  assert.match(css, /\.r65-conclusion-main\s*\{/)
  assert.match(css, /\.r65-conclusion-facts li\s*\{/)
  assert.match(css, /border-left: 3px solid #e60012/)
  assert.match(css, /background: #f8f9fb/)
  assert.match(css, /border-radius: 6px/)
  assert.match(css, /@media \(max-width: 680px\)/)
  assert.match(css, /overflow-wrap: anywhere/)
  assert.doesNotMatch(css, /grid-template|box-shadow/)
  assert.match(js, /section\.setAttribute\('aria-labelledby', 'r65ConclusionTitle'\)/)
  assert.match(js, /section\.setAttribute\('aria-live', 'polite'\)/)
  assert.match(css, /\.r65-ai-conclusion\[hidden\]/)
})

test('R65 不触及已验收路由或业务存储', () => {
  for (const protectedPath of ['/daily', '/payment', '/collection']) {
    assert.equal(js.includes(protectedPath), false)
    assert.equal(css.includes(protectedPath), false)
  }
  for (const forbidden of ['localStorage.setItem', 'sessionStorage.setItem', 'indexedDB', 'DELETE', 'PATCH', 'PUT']) {
    assert.equal(js.includes(forbidden), false, `发现越界能力：${forbidden}`)
  }
})
