import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { LvzaiSessionExpiredError } from '../src/lvzai-arrears-adapter.js'
import { LvzaiHttpTransport } from '../src/lvzai-http-transport.js'

function fixture(mode = 0o600) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvzai-transport-'))
  const statePath = path.join(root, 'state.json')
  const loginScript = path.join(root, 'login.py')
  fs.writeFileSync(loginScript, '# test only\n', { mode: 0o700 })
  fs.writeFileSync(statePath, JSON.stringify({ cookies: [{ name: 'SESSION', value: 'secret-cookie', domain: '.firstpm.com.cn' }] }), { mode })
  return { root, statePath, loginScript }
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

test('HTTP传输只读取600普通会话文件并对固定绿仔域名探活', async () => {
  const item = fixture()
  const requests: Array<{ url: string; init?: RequestInit }> = []
  try {
    const transport = new LvzaiHttpTransport({
      statePath: item.statePath, loginScript: item.loginScript,
      fetchImpl: async (url, init) => { requests.push({ url: String(url), init }); return jsonResponse({ data: [{ code: 'north' }] }) },
    })
    assert.equal(await transport.probe(), true)
    assert.equal(requests[0].url, 'https://oasis.firstpm.com.cn/qdp-oasis-web/common/getRegionTree')
    assert.equal((requests[0].init?.headers as Record<string, string>).Cookie, 'SESSION=secret-cookie')
    assert.equal(requests[0].init?.redirect, 'manual')
  } finally { fs.rmSync(item.root, { recursive: true, force: true }) }
})

test('会话权限宽于600或使用符号链接时失败关闭', async () => {
  const loose = fixture(0o640)
  try {
    const transport = new LvzaiHttpTransport({ statePath: loose.statePath, loginScript: loose.loginScript, fetchImpl: async () => jsonResponse({ data: [] }) })
    await assert.rejects(() => transport.probe(), /权限必须为600/)
  } finally { fs.rmSync(loose.root, { recursive: true, force: true }) }

  const linked = fixture()
  const link = path.join(linked.root, 'linked.json')
  fs.symlinkSync(linked.statePath, link)
  try {
    const transport = new LvzaiHttpTransport({ statePath: link, loginScript: linked.loginScript, fetchImpl: async () => jsonResponse({ data: [] }) })
    await assert.rejects(() => transport.probe(), /不得为符号链接/)
  } finally { fs.rmSync(linked.root, { recursive: true, force: true }) }
})

test('重新登录成功后强制收紧会话文件为600且不继承脚本输出', async () => {
  const item = fixture()
  try {
    fs.rmSync(item.statePath)
    let called = false
    const transport = new LvzaiHttpTransport({
      statePath: item.statePath, loginScript: item.loginScript,
      spawnLogin: async script => {
        called = true
        assert.equal(script, item.loginScript)
        fs.writeFileSync(item.statePath, JSON.stringify({ cookies: [{ name: 'SESSION', value: 'new-cookie', domain: 'pstar.firstpm.com.cn' }] }), { mode: 0o644 })
      },
      fetchImpl: async () => jsonResponse({}),
    })
    await transport.relogin()
    assert.equal(called, true)
    assert.equal(fs.statSync(item.statePath).mode & 0o777, 0o600)
  } finally { fs.rmSync(item.root, { recursive: true, force: true }) }
})

test('POST仅允许getArrearage固定路径，登录跳转与401识别为会话失效', async () => {
  const item = fixture()
  try {
    const requests: string[] = []
    const transport = new LvzaiHttpTransport({
      statePath: item.statePath, loginScript: item.loginScript,
      fetchImpl: async url => { requests.push(String(url)); return jsonResponse({}, 401) },
    })
    await assert.rejects(() => transport.post('/oas/other', {}), /拒绝未授权接口路径/)
    await assert.rejects(() => transport.post('/oas/getArrearage', {}), error => error instanceof LvzaiSessionExpiredError)
    assert.deepEqual(requests, ['https://pstar.firstpm.com.cn/qdp-polestar-web/oas/getArrearage'])
  } finally { fs.rmSync(item.root, { recursive: true, force: true }) }
})

test('非JSON或超出16MiB的响应不得进入逐户标准化', async () => {
  const item = fixture()
  try {
    const html = new LvzaiHttpTransport({
      statePath: item.statePath, loginScript: item.loginScript,
      fetchImpl: async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    await assert.rejects(() => html.post('/oas/getArrearage', {}), error => error instanceof LvzaiSessionExpiredError)

    const oversized = new LvzaiHttpTransport({
      statePath: item.statePath, loginScript: item.loginScript,
      fetchImpl: async () => jsonResponse({}, 200, { 'content-length': String(17 * 1024 * 1024) }),
    })
    await assert.rejects(() => oversized.post('/oas/getArrearage', {}), /超过16MiB/)
  } finally { fs.rmSync(item.root, { recursive: true, force: true }) }
})
