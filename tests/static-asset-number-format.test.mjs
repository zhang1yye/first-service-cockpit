import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetRoot = path.join(root, 'firstcare-cloud-local', 'assets', 'sortfix-20260806-percentcap1')

function readAsset(name) {
  return fs.readFileSync(path.join(assetRoot, name), 'utf8')
}

test('经营数据展示不再使用一位小数', () => {
  const businessAssets = [
    'chunk-4VAYZCQG.js',
    'chunk-YAFZUARX.js',
    'chunk-5ICXUZV4.js',
    'chunk-OTE3KXRM.js',
    'chunk-XGALVLQQ.js',
    'chunk-LR35IIDP.js',
    'chunk-YICGYIFC.js',
  ]

  for (const name of businessAssets) {
    const source = readAsset(name)
    const businessOnly = source
      .replaceAll('(p2.size / 1024).toFixed(1)', '')
      .replaceAll('(t.summary.latest.size / 1024).toFixed(1)', '')
    assert.doesNotMatch(businessOnly, /\.toFixed\(1\)/, `${name} 仍有一位小数的经营数据`)
  }
})

test('片区执行排名按真实完成率降序且进度条沿用100%封顶百分比', () => {
  const source = readAsset('chunk-C5JXPXJ4.js')
  assert.match(source, /compareCompletionRate\(a2\.rate, n\.rate, "desc", a2\.area, n\.area\)/)
  assert.match(source, /completionBarPercent\(t\.rate\)/)
  assert.match(source, /formatCompletionRate\(t\.rate\)/)
})

test('AI月报排名按收费率数值排序', () => {
  const source = readAsset('chunk-5ICXUZV4.js')
  assert.match(source, /\[\.\.\.s\.areaRank\]\.sort\(\(t3, r\) => Number\(r\.collectionRate \|\| 0\) - Number\(t3\.collectionRate \|\| 0\)\)/)
  assert.match(source, /\[\.\.\.s\.weakestProjects\]\.sort\(\(t3, r\) => Number\(t3\.collectionRate \|\| 0\) - Number\(r\.collectionRate \|\| 0\)\)/)
})

test('百分比格式与图表坐标统一为两位小数', () => {
  const source = readAsset('chunk-D3P3MDJ2.js')
  assert.match(source, /tickFormatter: \(c3\) => `\$\{\(c3 \* 100\)\.toFixed\(2\)\}%`/)
  assert.doesNotMatch(readAsset('chunk-YAFZUARX.js'), /\.toFixed\(0\)/)
})
