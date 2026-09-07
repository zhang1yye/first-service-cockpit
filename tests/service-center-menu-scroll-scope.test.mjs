import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root=path.resolve(import.meta.dirname,'..')
const source=fs.readFileSync(path.join(root,'firstcare-cloud-local','aph2-theme-20260808-progressive4.js'),'utf8')
const css=fs.readFileSync(path.join(root,'firstcare-cloud-local','aph2-theme-20260808-progressive4.css'),'utf8')

test('service-center scroll scope wraps only the table when its host also contains headings or controls',()=>{
  assert.doesNotMatch(source,/host\.classList\.add\('aph-service-center-scroll'\)/)
  assert.match(source,/aphScrollScope/)
  assert.match(source,/table-only/)
  assert.match(source,/host\.insertBefore\(scrollHost, table\)/)
  assert.match(source,/scrollHost\.appendChild\(table\)/)
  assert.match(source,/aphCollectionRowsScrollable = 'delegated-to-table-only'/)
  assert.doesNotMatch(source,/scrollContainer\.classList\.add\('aph-service-center-scroll'\)/)
})

test('collection view switch is kept outside detail scrolling and remains visible when details are selected',()=>{
  assert.match(source,/viewSwitch\.dataset\.aphMenuOutsideScroll = '1'/)
  assert.match(source,/viewSwitch\.scrollIntoView\(\{ block: 'start'/)
  assert.match(source,/menu\?\.closest\(["']\.aph-service-center-scroll["']\)/)
})

test('selected collection menu remains legible on the red active background',()=>{
  assert.match(css,/button\[aria-selected="true"\][^{]*\{[^}]*color:#fff!important/)
  assert.match(css,/-webkit-text-fill-color:#fff!important/)
})

test('sticky service-center headers keep high contrast text on a dark background',()=>{
  assert.match(css,/\.aph-service-center-scroll thead[^\{]*\{[^}]*background:#0d1928!important/)
  assert.match(css,/\.aph-service-center-scroll thead th[^\{]*\{[^}]*color:#f4f6f8!important/)
  assert.match(css,/\.aph-service-center-scroll thead th :where\(button,span,svg\)[^\{]*\{[^}]*color:#f4f6f8!important/)
})
