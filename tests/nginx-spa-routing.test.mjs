import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve(import.meta.dirname, '../deploy/nginx/cockpit-spa-routing.conf')

test('nginx SPA routing explicitly allows every supported deep link', () => {
  const conf = fs.readFileSync(file, 'utf8')
  for (const route of ['command','payment','collection','daily','projects','import','ai-report','ai-alerts','tasks','review','admin','system','arrears','login']) {
    assert.match(conf, new RegExp(`\\b${route.replace('-', '\\-')}\\b`), `missing ${route}`)
  }
  assert.match(conf, /projects\/\[0-9\]\+/)
  assert.match(conf, /try_files \$uri \/index\.html/)
  assert.match(conf, /location = \/admin\s*\{[\s\S]*try_files \/admin\/index\.html =404;/)
})

test('unknown paths preserve the SPA 404 page with HTTP 404 without affecting assets', () => {
  const conf = fs.readFileSync(file, 'utf8')
  assert.match(conf, /location \/assets\/\s*\{[\s\S]*try_files \$uri =404;/)
  assert.match(conf, /location @cockpit_spa_404\s*\{[\s\S]*error_page 404 =404 \/index\.html;[\s\S]*return 404;/)
  assert.match(conf, /location \/\s*\{[\s\S]*try_files \$uri \$uri\/ @cockpit_spa_404;/)
})
