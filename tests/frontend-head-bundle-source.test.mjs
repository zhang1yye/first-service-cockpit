import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDeferBundle, buildHeadBundle, buildStylesheetBundle } from '../scripts/build-frontend-bundles.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config/frontend-bundle-manifest.json'), 'utf8'))

test('生产head bundle可由11个受控源文件确定性重建', () => {
  const result = buildHeadBundle()
  assert.equal(result.sourceCount, 11)
  assert.equal(result.bytes, 157101)
  assert.equal(result.sha256, manifest.bundles.head.expectedSha256)
  assert.equal(result.ok, true)
})

test('生产defer bundle可由20个受控源文件确定性重建', () => {
  const result = buildDeferBundle()
  assert.equal(result.sourceCount, 20)
  assert.equal(result.bytes, 147999)
  assert.equal(result.sha256, manifest.bundles.defer.expectedSha256)
  assert.equal(result.ok, true)
})

test('生产CSS bundle可由62个非重复受控源文件确定性重建', () => {
  const result = buildStylesheetBundle()
  assert.equal(result.sourceCount, 62)
  assert.equal(result.bytes, 334190)
  assert.equal(result.sha256, manifest.bundles.stylesheet.expectedSha256)
  assert.equal(result.ok, true)
})

test('三个生产bundle均已恢复确定性构建', () => {
  assert.equal(manifest.bundles.defer.rebuildable, true)
  assert.equal(manifest.bundles.stylesheet.rebuildable, true)
  assert.equal(manifest.bundles.head.rebuildable, true)
})
