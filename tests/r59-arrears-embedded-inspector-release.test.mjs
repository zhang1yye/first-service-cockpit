import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const html = fs.readFileSync(path.join(root, 'firstcare-cloud-local/arrears/index.html'), 'utf8')
const js = fs.readFileSync(path.join(root, 'firstcare-cloud-local/arrears/aph2-r59-arrears-embedded-inspector-20260813-v1.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'firstcare-cloud-local/arrears/aph2-r59-arrears-embedded-inspector-20260813-v1.css'), 'utf8')

test('R59 嵌入 Inspector 修复层在 R55 工作台之后加载', () => {
  const r55Css = '/arrears/aph2-r55-arrears-workbench-20260812-v1.css?v=r55-arrears-workbench1'
  const r59Css = '/arrears/aph2-r59-arrears-embedded-inspector-20260813-v1.css?v=r59-arrears-inspector1'
  const r55Js = '/arrears/aph2-r55-arrears-workbench-20260812-v1.js?v=r55-arrears-workbench1'
  const r59Js = '/arrears/aph2-r59-arrears-embedded-inspector-20260813-v1.js?v=r59-arrears-inspector1'
  assert.equal(html.match(new RegExp(r59Css.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length, 1)
  assert.equal(html.match(new RegExp(r59Js.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length, 1)
  assert.ok(html.indexOf(r59Css) > html.indexOf(r55Css))
  assert.ok(html.indexOf(r59Js) > html.indexOf(r55Js))
})

test('R59 按外层移动导航与 iframe 的真实重叠量计算安全顶距', () => {
  assert.match(js, /navigationRect\.bottom - frameRect\.top/)
  assert.match(js, /--r59-arrears-inspector-top-inset/)
  assert.match(js, /inspector\.style\.setProperty\('top', `\$\{inset\}px`, 'important'\)/)
  assert.match(css, /top:\s*var\(--r59-arrears-inspector-top-inset, 0px\)/)
  assert.match(css, /@media \(max-width: 860px\)/)
})

test('R59 在移动 Inspector 打开时隔离外层壳层并在关闭时恢复', () => {
  assert.match(js, /window\.frameElement/)
  assert.match(js, /sibling\.inert = true/)
  assert.match(js, /node\.inert = false/)
  assert.match(js, /MutationObserver/)
  assert.match(js, /attributeFilter: \['hidden', 'role', 'aria-modal'\]/)
  assert.match(js, /window\.parent\.addEventListener\('scroll', scheduleSync/)
})

test('R59 只处理布局与模态边界，不访问或修改业务数据', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', '/api/', 'localStorage', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(js.includes(forbidden), false, `禁止出现 ${forbidden}`)
  }
})
