import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const overlay = path.join(root, 'production-overlays/cockpit-r157-refresh-route-preservation-20260830-v1/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')
const headBundle = fs.readFileSync(path.join(overlay, 'assets/cockpit-bundle-head-20260816.js'), 'utf8')

function refreshRouteGuard() {
  const start = headBundle.indexOf('/* R157：刷新时清空工作页签，但保留当前深链路由。 */')
  assert.ok(start >= 0, 'R157 refresh guard must exist')
  const end = headBundle.indexOf('})();', start)
  assert.ok(end > start, 'R157 refresh guard must be a complete IIFE')
  return headBundle.slice(start, end + 5)
}

test('R157 cache-busts the corrected head bundle', () => {
  assert.match(index, /cockpit-bundle-head-20260816\.js\?v=r157-refresh-route-preservation-20260830-v1/)
  assert.doesNotMatch(headBundle, /window\.location\.replace\('\/'\)/)
})

test('a hard refresh clears stale tabs without replacing the current deep route', () => {
  const removedKeys: string[] = []
  const replaceCalls: string[] = []
  const dataset: Record<string, string> = {}
  const appended: unknown[] = []

  vm.runInNewContext(refreshRouteGuard(), {
    performance: { getEntriesByType: () => [{ type: 'reload' }] },
    document: {
      documentElement: { dataset },
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { append: (value: unknown) => appended.push(value) },
    },
    window: {
      sessionStorage: { removeItem: (key: string) => removedKeys.push(key) },
      location: { pathname: '/arrears', replace: (target: string) => replaceCalls.push(target) },
    },
  })

  assert.deepEqual(removedKeys, ['aph-open-tabs-v1'])
  assert.deepEqual(replaceCalls, [])
  assert.equal(dataset.r157TabsReset, 'true')
  assert.equal(appended.length, 1)
})
