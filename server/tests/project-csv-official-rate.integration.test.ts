import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-project-csv-official-rate-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'project-csv-official-rate-secret-at-least-32-characters'
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: exportRouter }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/export.js'),
])

db.prepare(`INSERT INTO projects
  (area,name,annual_income,annual_cost,ytd_income,ytd_cost,receivable,received,
   official_collection_rate,quality_score,safety_incidents,customer_satisfaction,complaint_count,
   project_code,active_status,validation_status,source_batch)
  VALUES('测试片区','官方率缺失项目',100,80,70,50,100,88,NULL,90,0,91,1,
    'CSV-OFFICIAL-RATE-NULL','active','verified','controlled-csv-test')`).run()

const app = express()
app.use((req, _res, next) => {
  ;(req as express.Request & { user?: { userId: number; username: string; role: string } }).user = {
    userId: 1, username: 'csv-test-admin', role: 'admin',
  }
  next()
})
app.use(exportRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('CSV测试端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('项目CSV不得用实收除以应收冒充缺失的官方收费率', async () => {
  const response = await fetch(`${baseUrl}/api/export/projects-csv`)
  const text = await response.text()
  assert.equal(response.status, 200, text)
  assert.match(response.headers.get('content-type') || '', /^text\/csv\b/i)
  const row = text.replace(/^\uFEFF/, '').trim().split('\n')[1].split(',')
  assert.equal(row[1], '官方率缺失项目')
  assert.equal(row[10], '100')
  assert.equal(row[11], '88')
  assert.equal(row[12], '', '官方率缺失必须导出空值，不得回退为88.0')
})
