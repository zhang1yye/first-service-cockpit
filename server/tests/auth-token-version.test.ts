import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'

const indexSource = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-auth-version-'))
const secret = 'auth-version-contract-secret-at-least-32-characters'
process.env.COCKPIT_DB_PATH = path.join(root, 'cockpit.db')
process.env.COCKPIT_ROOT = root
process.env.COCKPIT_ADMIN_PASSWORD_FILE = path.join(root, 'admin-password')
process.env.JWT_SECRET = secret
process.env.NODE_ENV = 'test'

const [{ default: db }, { default: authRouter }] = await Promise.all([
  import('../src/db.js'),
  import('../src/routes/auth.js'),
])

const app = express()
app.use(express.json())
app.use(authRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  if (server.listening) return resolve()
  server.once('listening', resolve)
  server.once('error', reject)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('认证版本测试端口未绑定')
const baseUrl = `http://127.0.0.1:${address.port}`

after(() => {
  server.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('旧JWT仅在版本0兼容，改密后旧JWT立即失效', async () => {
  assert.match(indexSource, /selfServicePassword[\s\S]*\/api\/auth\/password/)
  const username = 'legacy-token-member'
  const oldPassword = 'Legacy-Member-2026'
  const newPassword = 'Renewed-Member-2026'
  const inserted = db.prepare(`INSERT INTO users
    (username,password_hash,role,area_scope,project_scope,service_center_scope,token_version)
    VALUES(?,?,'admin','','','',0)`).run(username, bcrypt.hashSync(oldPassword, 4))
  const userId = Number(inserted.lastInsertRowid)
  const legacyToken = jwt.sign({ userId, username, role: 'admin' }, secret, { expiresIn: '1h' })

  const before = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${legacyToken}` },
  })
  assert.equal(before.status, 200)

  const changed = await fetch(`${baseUrl}/api/auth/password`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${legacyToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, newPassword }),
  })
  assert.equal(changed.status, 200)
  assert.equal((await changed.json() as any).reauthenticationRequired, true)
  assert.equal((db.prepare('SELECT token_version FROM users WHERE id=?').get(userId) as any).token_version, 1)

  const afterChange = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${legacyToken}` },
  })
  assert.equal(afterChange.status, 401)

  const relogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: newPassword }),
  })
  assert.equal(relogin.status, 200)
})
