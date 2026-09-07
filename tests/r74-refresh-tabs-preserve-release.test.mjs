import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const js = await readFile(
  new URL('firstcare-cloud-local/aph2-r74-refresh-tabs-preserve-20260813-v1.js', root),
  'utf8',
)

test('R74 只在刷新且存在页签快照时启动保护', () => {
  assert.match(js, /navigation\?\.type !== 'reload' \|\| !snapshot/)
  assert.match(js, /sessionStorage\.getItem\(OPEN_TABS_KEY\)/)
})

test('R74 只阻止 R44 删除打开页签键', () => {
  assert.match(js, /this === window\.sessionStorage && key === OPEN_TABS_KEY/)
  assert.match(js, /return nativeRemoveItem\.call\(this, key\)/)
  assert.doesNotMatch(js, /localStorage/)
})

test('R74 在 DOMContentLoaded 后恢复原生 removeItem 并复核快照', () => {
  assert.match(js, /addEventListener\('DOMContentLoaded'/)
  assert.match(js, /Storage\.prototype\.removeItem = nativeRemoveItem/)
  assert.match(js, /sessionStorage\.setItem\(OPEN_TABS_KEY, snapshot\)/)
  assert.match(js, /\{ once: true \}/)
})

test('R74 不改路由、不访问接口或认证数据', () => {
  assert.doesNotMatch(js, /history\.|location\.|fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  assert.doesNotMatch(js, /cockpit_token|authToken|\/api\//)
})
