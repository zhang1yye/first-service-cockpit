import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import express from 'express'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-import-preview-null-'))
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = 'import-preview-null-integration-secret-32'
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: importRouter }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/import.js'),
])

const app = express()
app.use(importRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('导入预览测试端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('CSV预览分母为0时收缴率保持null而不是补0', async () => {
  const csv = [
    '片区,项目名称,应收,实收,品质评分,客户满意度',
    '测试片区,真实性零分母测试项目,0,0,90,95',
  ].join('\n')
  const form = new FormData()
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'preview.csv')
  const response = await fetch(`${baseUrl}/api/import/preview`, { method: 'POST', body: form })
  const body = await response.json() as { previewRows?: Array<{ collectionRate?: number | null }> }
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.previewRows?.[0]?.collectionRate, null)
})
