import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const overlay = path.join(root, 'production-overlays/cockpit-r135-merge-withdrawn-area-20260827-v2/payload')
const index = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8')
const styles = fs.readFileSync(path.join(overlay, 'aph2-r135-hide-data-basis-20260827-v1.css'), 'utf8')
const master = fs.readFileSync(path.join(root, 'server/src/service-center-master.ts'), 'utf8')

// 用户指定的是同一片区的历史别名，不是删除回款事实。
test('R135 canonicalizes both withdrawn area labels into one ranking group', () => {
  assert.match(master, /area === '已撤场项目' \|\| area === SERVICE_CENTER_WITHDRAWN_AREA/)
  assert.match(master, /canonicalServiceCenterArea\(change\?\.new_area \|\| sourceArea\)/)
})

test('R135 removes the bottom data-basis presentation and its reserved space', () => {
  const href = '/aph2-r135-hide-data-basis-20260827-v1.css?v=r135-hide-basis1'
  assert.match(index, new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.ok(index.indexOf(href) > index.indexOf('/aph2-r131-service-center-master-20260826-v1.css'))
  assert.match(styles, /#aph-r90-operating-capabilities-host/)
  assert.match(styles, /#aph-r90-operating-capabilities/)
  assert.match(styles, /display: none !important/)
  assert.match(styles, /min-height: 0 !important/)
})

test('R135 keeps operating-capability data available to existing runtime consumers', () => {
  assert.match(index, /aph2-r90-operating-capabilities-20260816-v1\.js/)
  assert.match(index, /aph-r90-operating-capabilities-host/)
})
