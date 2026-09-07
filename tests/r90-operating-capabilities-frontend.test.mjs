import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'firstcare-cloud-local/aph2-r90-operating-capabilities-20260816-v1.js')
const cssPath = path.join(root, 'firstcare-cloud-local/aph2-r90-operating-capabilities-20260816-v1.css')
const source = fs.readFileSync(sourcePath, 'utf8')
const css = fs.readFileSync(cssPath, 'utf8')

test('R90前端能力模块只读取正式能力接口并显式标注当前不接入的项目指标', () => {
  assert.match(source, /fetch\('\/api\/operating-capabilities'/)
  assert.match(source, /当前系统不接入/)
  assert.match(source, /暂无已验证记录/)
  assert.match(source, /暂无已发布正式批次/)
  assert.match(source, /项目目录只用于名称与归属/)
  assert.match(source, /aph-r90-operating-capabilities-host/)
  assert.match(source, /insertAdjacentElement\('afterend'/)
  assert.doesNotMatch(source, /Math\.random|演示数据|mock/i)
})

test('R90模块在三个保护路由不发请求也不挂载内容', () => {
  for (const pathname of ['/daily', '/payment', '/collection']) {
    let fetchCount = 0
    const document = {
      documentElement: { dataset: {} },
      getElementById: () => null,
      querySelector: () => { throw new Error('保护路由不应查询挂载节点') }
    }
    const window = {
      location: { pathname },
      localStorage: { getItem: () => 'token' },
      fetch: async () => { fetchCount += 1 },
      addEventListener: () => {},
      dispatchEvent: () => {},
      setTimeout: () => {}
    }
    vm.runInNewContext(source, { window, document, CustomEvent: class {} })
    assert.equal(fetchCount, 0, `${pathname} 不得请求能力接口`)
  }
})

test('R90数据依据保持次级呈现并提供移动端单列布局', () => {
  assert.match(css, /#aph-r90-operating-capabilities/)
  assert.match(css, /@media \(max-width: 640px\)/)
  assert.match(css, /grid-template-columns: 1fr/)
})
