import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const routeSource = readFileSync(new URL('../src/routes/regional-assistant.ts', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

test('assistant context advertises the complete company operating-advisor chain', () => {
  for (const capability of ['可信经营数据', '经营异常识别', '已批准标准引用', '有依据的管理建议']) {
    assert.match(routeSource, new RegExp(capability))
  }
})

test('server index mounts the company operating-advisor routes', () => {
  assert.match(indexSource, /import regionalAssistantRouter from '.\/routes\/regional-assistant\.js'/)
  assert.match(indexSource, /app\.use\(regionalAssistantRouter\)/)
})
