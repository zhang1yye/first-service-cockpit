import assert from 'node:assert/strict'
import test from 'node:test'
import express, { type Request } from 'express'
import { clientIp, loginLocked, recordLoginFailure } from '../src/login-rate-limit.js'

function request(ip: string, spoofedForwardedFor = ''): Request {
  return {
    ip,
    headers: spoofedForwardedFor ? { 'x-forwarded-for': spoofedForwardedFor } : {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request
}

test('login limiter uses the trusted proxy result and ignores a spoofed X-Forwarded-For prefix', () => {
  const trustedClient = request('198.51.100.145', '203.0.113.1, 198.51.100.145')
  assert.equal(clientIp(trustedClient), '198.51.100.145')

  for (let attempt = 0; attempt < 8; attempt += 1) recordLoginFailure(trustedClient)
  assert.equal(loginLocked(trustedClient).locked, true)

  const differentTrustedClient = request('198.51.100.146', '203.0.113.1, 198.51.100.145')
  assert.equal(loginLocked(differentTrustedClient).locked, false)
})

test('Express loopback trust selects the nearest untrusted address instead of a client-supplied prefix', async () => {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.get('/ip', (req, res) => res.json({ ip: clientIp(req) }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const response = await fetch(`http://127.0.0.1:${address.port}/ip`, {
      headers: { 'X-Forwarded-For': '203.0.113.1, 198.51.100.145' },
    })
    assert.deepEqual(await response.json(), { ip: '198.51.100.145' })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
