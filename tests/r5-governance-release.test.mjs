import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const site = path.join(root, 'firstcare-cloud-local')
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8')
const releaseJs = 'aph2-r6-operations-20260810-v6.js'
const releaseCss = 'aph2-r6-operations-20260810-v2.css'
const jsPath = path.join(site, releaseJs)
const cssPath = path.join(site, releaseCss)
const adminSource = fs.readFileSync(path.join(root, 'admin-web/src/App.jsx'), 'utf8')
const adminCss = fs.readFileSync(path.join(root, 'admin-web/src/styles.css'), 'utf8')

test('R6 remains before the R7 remediation layer and the retired task boundary stays active', () => {
  assert.ok(fs.existsSync(jsPath))
  assert.ok(fs.existsSync(cssPath))
  assert.match(html, new RegExp(releaseJs.replaceAll('.', '\\.')))
  assert.match(html, new RegExp(releaseCss.replaceAll('.', '\\.')))
  assert.ok(html.indexOf('aph2-theme-20260809-remediation3.js') < html.indexOf(releaseJs))
  assert.ok(html.indexOf('task-module-retired.js') < html.indexOf(releaseJs))
  assert.ok(html.indexOf(releaseJs) < html.indexOf('aph2-r7-remediation-20260810-v3.js'))
})

test('command workbench no longer mounts the governance panel or restores the retired task module', () => {
  const source = fs.readFileSync(jsPath, 'utf8')
  assert.match(source, /function schedule\(\) \{\s*applyPageFixes\(\)\s*cleanup\(\)/)
  assert.doesNotMatch(source, /\/api\/tasks/)
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PUT|DELETE)/)
})

test('system management owns publication and quality responsibility content', () => {
  const source = fs.readFileSync(jsPath, 'utf8')
  const css = fs.readFileSync(cssPath, 'utf8')
  assert.match(adminSource, /数据真实性中心/)
  assert.match(adminSource, /正式发布状态/)
  assert.match(adminSource, /未闭环/)
  assert.match(source, /document\.querySelector\(['"]#main-content['"]\)/)
  assert.match(css, /\.r5-governance-slot/)
})

test('admin R5 exposes publication state, due dates, evidence and review without coercing unknowns', () => {
  for (const token of [
    '/api/data-sources/publication-status',
    'dueDate',
    'evidenceRef',
    'timingLabel',
    '正式发布状态',
    '截止日期',
    '证据位置',
    '复核结论',
  ]) assert.match(adminSource, new RegExp(token.replaceAll('/', '\\/')))
  assert.match(adminSource, /\?\?\s*['"]—['"]/)
  assert.match(adminCss, /publication-status/)
  assert.match(adminCss, /quality-timing/)
})

test('R6 governance summaries remain usable on narrow mobile screens', () => {
  const css = fs.readFileSync(cssPath, 'utf8')
  assert.match(css, /@media\s*\(max-width:\s*640px\)/)
  assert.match(css, /\.r5-governance-grid/)
  assert.match(adminCss, /@media\(max-width:850px\)/)
})
