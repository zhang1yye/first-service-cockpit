import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const payload = path.join(root, 'production-overlays/cockpit-r163-r144-arrears-restoration-20260831-v1/payload')
const source = name => fs.readFileSync(path.join(payload, name), 'utf8')

test('R163在R162生产基线上恢复R144精简欠费诊断且保留当前前端基线', () => {
  const index = source('index.html')
  assert.match(index, /cockpit-r160-daily-only-20260830-v1/)
  assert.match(index, /aph2-r155-screenshot-distillation-arrears-scope-20260830-v1\.js/)
  assert.match(index, /aph2-r163-r144-arrears-diagnosis-20260831-v1\.css/)
  assert.match(index, /aph2-r163-r144-arrears-diagnosis-20260831-v1\.js/)
  assert.doesNotMatch(index, /aph2-r144-manual-arrears-diagnosis-20260828-v1|aph2-r153-arrears-blank-guard/)
})

test('R163严格采用R144业务口径', () => {
  const script = source('aph2-r163-r144-arrears-diagnosis-20260831-v1.js')
  for (const copy of [
    'AI欠费经营诊断',
    '生成经营诊断',
    '欠费台账',
    '聊天记录',
    '分析依据',
    '整体判断',
    '原因汇总分析',
    '合理判断',
    '已知事实',
    '待核实',
    '建议的管理动作',
    '原因结构',
    '优先调查名单',
  ]) assert.match(script, new RegExp(copy))
  assert.match(script, /ledgerInput\.required\s*=\s*true/)
  assert.match(script, /communicationInput\.required\s*=\s*false/)
  assert.match(script, /\/api\/arrears\/batches/)
  assert.match(script, /\/diagnosis/)
  assert.doesNotMatch(script, /connectors\/operating-analysis|任务派发|评分|导出|绿仔/)
})

test('R163仅在替代工作区真实挂载后隐藏原生内容并可离开路由恢复', () => {
  const script = source('aph2-r163-r144-arrears-diagnosis-20260831-v1.js')
  const prependAt = script.indexOf('workspace.prepend(root)')
  const activateAt = script.indexOf("document.documentElement.classList.add('arrears-command-active')", prependAt)
  assert.ok(prependAt >= 0 && activateAt > prependAt, '必须先挂载R144工作区，再激活隐藏原生内容的样式')
  assert.match(script, /if \(!root\.isConnected\) return/)
  assert.match(script, /if \(!onArrearsRoute\)[\s\S]*classList\.remove\('arrears-command-active'\)/)
  assert.match(script, /aphR128Hidden === 'arrears-workflow-hero'/)
})

test('R163保留R144桌面与移动布局及可访问触控尺寸', () => {
  const styles = source('aph2-r163-r144-arrears-diagnosis-20260831-v1.css')
  assert.match(styles, /grid-template-columns:minmax\(0,2fr\) minmax\(280px,1fr\)/)
  assert.match(styles, /@media\(max-width:720px\)/)
  assert.match(styles, /min-height:44px/)
  assert.match(styles, /focus-visible/)
  assert.match(styles, /prefers-reduced-motion:reduce/)
})
