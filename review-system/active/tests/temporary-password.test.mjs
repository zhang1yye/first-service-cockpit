import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const formerSharedSecret = [70,105,114,115,116,49,50,51,52,53,54].map(code => String.fromCharCode(code)).join('')

test('temporary passwords are high-entropy, strong, and unique', async () => {
  const { generateTemporaryPassword } = await import('../backend/account-password.js')
  const values = new Set(Array.from({ length: 64 }, () => generateTemporaryPassword()))
  assert.equal(values.size, 64)
  for (const value of values) {
    assert.ok(value.length >= 16)
    assert.match(value, /[A-Z]/)
    assert.match(value, /[a-z]/)
    assert.match(value, /\d/)
    assert.doesNotMatch(value, /[\s'"`\\/]/)
  }
})

test('public frontend never embeds the former shared credential', () => {
  const files = [
    'frontend/src/views/UsersView.jsx',
    'frontend/src/views/ChangePasswordView.jsx'
  ]
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    assert.equal(source.includes(formerSharedSecret), false, file)
  }
})

test('user creation and non-admin resets use server-generated one-time credentials', () => {
  const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8')
  const usersView = fs.readFileSync(path.join(root, 'frontend/src/views/UsersView.jsx'), 'utf8')
  assert.match(server, /generateTemporaryPassword\(\)/)
  assert.match(server, /temporaryPassword/)
  assert.equal(server.includes(`password = '${formerSharedSecret}'`), false)
  assert.match(usersView, /一次性临时密码/)
  assert.match(usersView, /普通账号由系统生成/)
  assert.match(server, /temporaryCredentialConsumedAt/)
  assert.match(server, /临时凭据已使用/)
  assert.match(server, /mustChangePassword: normalizedRole !== '管理员'/)
})

test('verified cockpit admin SSO remains usable when password-based review accounts are disabled for recovery', () => {
  const server = fs.readFileSync(path.join(root, 'backend/server.js'), 'utf8')
  assert.match(server, /normalizeUserRole\(payload\.role\) !== '管理员'/)
  assert.match(server, /ssoOnly:\s*true/)
  assert.match(server, /username:\s*String\(payload\.username/)
  assert.match(server, /ssoOnly:\s*user\.ssoOnly === true/)
  assert.match(server, /if \(session\.ssoOnly === true\)/)
})
