import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const payloadRoot = new URL('../production-overlays/cockpit-r201-presentation-entry-20260902-v1/payload/', import.meta.url)
const read = file => fs.readFileSync(new URL(file, payloadRoot), 'utf8')

test('R201 在驾驶舱入口加载独立汇报按钮资产', () => {
  const index = read('index.html')
  assert.match(index, /aph2-r201-presentation-entry-20260902-v1\.css/)
  assert.match(index, /aph2-r201-presentation-entry-20260902-v1\.js/)
})

test('R201 桌面按钮位于当前成员信息块之后且指向汇报页', () => {
  const script = read('aph2-r201-presentation-entry-20260902-v1.js')
  assert.match(script, /PRESENTATION_PATH = '\/presentation\/ai-competition\/'/)
  assert.match(script, /findDesktopUserBlock/)
  assert.match(script, /classList\.contains\('border-l'\)/)
  assert.match(script, /insertAdjacentElement\('afterend'/)
  assert.match(script, /aria-label', '进入AI大赛汇报'/)
})

test('R201 所有已登录成员均可见且移动端也有入口', () => {
  const script = read('aph2-r201-presentation-entry-20260902-v1.js')
  const style = read('aph2-r201-presentation-entry-20260902-v1.css')
  assert.doesNotMatch(script, /role\s*===|zd\(\)|admin/i)
  assert.match(script, /nav\[aria-label="移动端主导航"\]/)
  assert.match(script, /navigation\.append\(entry\(MOBILE_ID, 'mobile'\)\)/)
  assert.match(style, /min-width:\s*1024px/)
  assert.match(style, /height:\s*44px/)
})

test('R201 沿用R200汇报页、12页幻灯片和两段录屏', () => {
  assert.ok(fs.existsSync(new URL('presentation/ai-competition/index.html', payloadRoot)))
  assert.ok(fs.existsSync(new URL('presentation/ai-competition/media/aph.mp4', payloadRoot)))
  assert.ok(fs.existsSync(new URL('presentation/ai-competition/media/lvzai.mp4', payloadRoot)))
  for (let page = 1; page <= 12; page += 1) {
    assert.ok(fs.existsSync(new URL(`presentation/ai-competition/slides/slide-${String(page).padStart(2, '0')}.webp`, payloadRoot)))
  }
})
