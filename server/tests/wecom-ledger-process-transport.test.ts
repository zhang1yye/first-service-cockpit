import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WecomLedgerProcessTransport, WecomLedgerSessionExpiredError } from '../src/wecom-ledger-process-transport.js'

function executable(root: string, body: string, name = 'extractor.mjs'): string {
  const file = path.join(root, name)
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 })
  fs.chmodSync(file, 0o700)
  return file
}

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-transport-')) }

const previousSession = process.env.WECOM_SESSION_FILE
const previousLeak = process.env.WECOM_SHOULD_NOT_LEAK
process.env.WECOM_SHOULD_NOT_LEAK = 'forbidden-value'
test.after(() => {
  if (previousSession === undefined) delete process.env.WECOM_SESSION_FILE; else process.env.WECOM_SESSION_FILE = previousSession
  if (previousLeak === undefined) delete process.env.WECOM_SHOULD_NOT_LEAK; else process.env.WECOM_SHOULD_NOT_LEAK = previousLeak
})

test('受控提取器通过stdin接收范围，stdout仅返回完整JSON且不继承无关环境变量', async () => {
  const root = temporary()
  try {
    const file = executable(root, `let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{const q=JSON.parse(s); if(process.env.WECOM_SHOULD_NOT_LEAK) process.exit(9); process.stdout.write(JSON.stringify({rows:[{recordId:'r1',roomSign:'BJ-JRHY-1-1-1005',operation:q.operation,documentId:q.documentId,sheetId:q.sheetId,businessDate:q.businessDate}],total:1}))})`)
    const transport = new WecomLedgerProcessTransport({ executablePath: file })
    const result = await transport.readSheet({ documentId: 'doc-controlled', sheetId: 'sheet-controlled', businessDate: '2026-08-28' })
    assert.equal(result.total, 1)
    assert.deepEqual(result.rows[0], { recordId: 'r1', roomSign: 'BJ-JRHY-1-1-1005', operation: 'read_sheet', documentId: 'doc-controlled', sheetId: 'sheet-controlled', businessDate: '2026-08-28' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('提取器权限、所有者、符号链接及会话文件权限异常时失败关闭', () => {
  const root = temporary()
  const oldSession = process.env.WECOM_SESSION_FILE
  try {
    const file = executable(root, `process.stdout.write('{"rows":[],"total":0}')`)
    fs.chmodSync(file, 0o722)
    assert.throws(() => new WecomLedgerProcessTransport({ executablePath: file }), /不得允许组或其他用户写入/)
    fs.chmodSync(file, 0o600)
    assert.throws(() => new WecomLedgerProcessTransport({ executablePath: file }), /缺少任务用户执行权限/)
    fs.chmodSync(file, 0o700)
    const link = path.join(root, 'extractor-link')
    fs.symlinkSync(file, link)
    assert.throws(() => new WecomLedgerProcessTransport({ executablePath: link }), /不得为符号链接/)
    const session = path.join(root, 'session.json')
    fs.writeFileSync(session, '{}', { mode: 0o644 })
    process.env.WECOM_SESSION_FILE = session
    assert.throws(() => new WecomLedgerProcessTransport({ executablePath: file }), /权限必须为600/)
    fs.chmodSync(session, 0o600)
    assert.doesNotThrow(() => new WecomLedgerProcessTransport({ executablePath: file }))
  } finally {
    if (oldSession === undefined) delete process.env.WECOM_SESSION_FILE; else process.env.WECOM_SESSION_FILE = oldSession
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('非JSON、声明数量不一致、超限响应和非零退出均不返回部分数据', async () => {
  const root = temporary()
  try {
    const invalid = executable(root, `process.stdout.write('not-json')`, 'invalid.mjs')
    await assert.rejects(new WecomLedgerProcessTransport({ executablePath: invalid }).readSheet({ documentId: 'd', sheetId: 's', businessDate: '2026-08-28' }), /非JSON/)
    const mismatch = executable(root, `process.stdout.write(JSON.stringify({rows:[{}],total:2}))`, 'mismatch.mjs')
    await assert.rejects(new WecomLedgerProcessTransport({ executablePath: mismatch }).readSheet({ documentId: 'd', sheetId: 's', businessDate: '2026-08-28' }), /声明行数与明细不一致/)
    const oversized = executable(root, `process.stdout.write(JSON.stringify({rows:[{value:'x'.repeat(4096)}],total:1}))`, 'oversized.mjs')
    await assert.rejects(new WecomLedgerProcessTransport({ executablePath: oversized, maximumResponseBytes: 1024 }).readSheet({ documentId: 'd', sheetId: 's', businessDate: '2026-08-28' }), /超过16MiB安全上限/)
    const failed = executable(root, `process.exit(3)`, 'failed.mjs')
    await assert.rejects(new WecomLedgerProcessTransport({ executablePath: failed }).readSheet({ documentId: 'd', sheetId: 's', businessDate: '2026-08-28' }), /执行失败/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('会话失效使用专用错误，超时和AbortSignal会终止子进程', async () => {
  const root = temporary()
  try {
    const expired = executable(root, `process.exit(42)`, 'expired.mjs')
    await assert.rejects(new WecomLedgerProcessTransport({ executablePath: expired }).readSheet({ documentId: 'd', sheetId: 's', businessDate: '2026-08-28' }), WecomLedgerSessionExpiredError)
    const slow = executable(root, `setTimeout(()=>process.stdout.write('{"rows":[],"total":0}'),10000)`, 'slow.mjs')
    await assert.rejects(new WecomLedgerProcessTransport({ executablePath: slow, timeoutMs: 1000 }).readSheet({ documentId: 'd', sheetId: 's', businessDate: '2026-08-28' }), /超时/)
    const controller = new AbortController()
    const pending = new WecomLedgerProcessTransport({ executablePath: slow, timeoutMs: 10000 }).readSheet({ documentId: 'd', sheetId: 's', businessDate: '2026-08-28' }, controller.signal)
    controller.abort()
    await assert.rejects(pending, /已取消/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
