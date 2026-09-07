import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')

test('server does not ship the vulnerable unmaintained xlsx package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies?.xlsx, undefined)
  assert.match(String(pkg.dependencies?.['@e965/xlsx'] || ''), /^\^?0\.20\./)
  for (const relative of ['src/arrears-workbook-worker.ts', 'src/routes/arrears-analysis.ts', 'src/routes/import.ts']) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    assert.doesNotMatch(source, /require\(['"]xlsx['"]\)|from ['"]xlsx['"]/)
  }
})
