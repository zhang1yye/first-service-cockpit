import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { QxmEvidenceProcessTransport, QxmEvidenceSessionExpiredError } from '../src/qxm-evidence-process-transport.js'

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'qxm-transport-')) }
function executable(root: string, body: string, name = 'extractor.mjs') { const file = path.join(root, name); fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 }); fs.chmodSync(file, 0o700); return file }
const previousSession = process.env.QXM_SESSION_FILE, previousLeak = process.env.QXM_SHOULD_NOT_LEAK
process.env.QXM_SHOULD_NOT_LEAK = 'forbidden'
test.after(() => { if (previousSession === undefined) delete process.env.QXM_SESSION_FILE; else process.env.QXM_SESSION_FILE = previousSession; if (previousLeak === undefined) delete process.env.QXM_SHOULD_NOT_LEAK; else process.env.QXM_SHOULD_NOT_LEAK = previousLeak })

test('企小码提取器通过stdin接收受控分页请求且不继承无关环境变量', async () => {
  const root = temporary()
  try {
    const file = executable(root, `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const q=JSON.parse(s);if(process.env.QXM_SHOULD_NOT_LEAK)process.exit(9);process.stdout.write(JSON.stringify({rows:[{operation:q.operation,departmentId:q.departmentId,businessDate:q.businessDate,cursor:q.cursor,limit:q.limit}],total:1,nextCursor:'next',hasMore:false}))})`)
    const result = await new QxmEvidenceProcessTransport({ executablePath: file }).readMessages({ departmentId: 'controlled-dept', businessDate: '2026-08-28', cursor: 'current', limit: 100 })
    assert.deepEqual(result, { rows: [{ operation: 'read_messages', departmentId: 'controlled-dept', businessDate: '2026-08-28', cursor: 'current', limit: 100 }], total: 1, nextCursor: 'next', hasMore: false })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('提取器与会话文件权限、所有者和符号链接异常时失败关闭', () => {
  const root = temporary(), old = process.env.QXM_SESSION_FILE
  try {
    const file = executable(root, `process.stdout.write('{}')`)
    fs.chmodSync(file, 0o722); assert.throws(() => new QxmEvidenceProcessTransport({ executablePath: file }), /不得允许组或其他用户写入/)
    fs.chmodSync(file, 0o600); assert.throws(() => new QxmEvidenceProcessTransport({ executablePath: file }), /缺少任务用户执行权限/)
    fs.chmodSync(file, 0o700); const link = path.join(root, 'link'); fs.symlinkSync(file, link); assert.throws(() => new QxmEvidenceProcessTransport({ executablePath: link }), /不得为符号链接/)
    const session = path.join(root, 'session.json'); fs.writeFileSync(session, '{}', { mode: 0o644 }); process.env.QXM_SESSION_FILE = session
    assert.throws(() => new QxmEvidenceProcessTransport({ executablePath: file }), /权限必须为600/)
    fs.chmodSync(session, 0o600); assert.doesNotThrow(() => new QxmEvidenceProcessTransport({ executablePath: file }))
  } finally { if (old === undefined) delete process.env.QXM_SESSION_FILE; else process.env.QXM_SESSION_FILE = old; fs.rmSync(root, { recursive: true, force: true }) }
})

test('非JSON、响应结构异常、单页超限、超大响应和非零退出均拒绝部分结果', async () => {
  const root = temporary(), input = { departmentId: 'd', businessDate: '2026-08-28', cursor: '', limit: 1 }
  try {
    await assert.rejects(new QxmEvidenceProcessTransport({ executablePath: executable(root, `process.stdout.write('bad')`, 'bad.mjs') }).readMessages(input), /非JSON/)
    await assert.rejects(new QxmEvidenceProcessTransport({ executablePath: executable(root, `process.stdout.write(JSON.stringify({rows:[],total:0}))`, 'shape.mjs') }).readMessages(input), /缺少rows/)
    await assert.rejects(new QxmEvidenceProcessTransport({ executablePath: executable(root, `process.stdout.write(JSON.stringify({rows:[{},{}],total:2,nextCursor:'x',hasMore:false}))`, 'limit.mjs') }).readMessages(input), /单页数量超过/)
    await assert.rejects(new QxmEvidenceProcessTransport({ executablePath: executable(root, `process.stdout.write(JSON.stringify({rows:[{x:'x'.repeat(4096)}],total:1,nextCursor:'x',hasMore:false}))`, 'large.mjs'), maximumResponseBytes: 1024 }).readMessages(input), /超过16MiB/)
    await assert.rejects(new QxmEvidenceProcessTransport({ executablePath: executable(root, `process.exit(3)`, 'failed.mjs') }).readMessages(input), /执行失败/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('会话失效、超时和取消使用受控错误且终止子进程', async () => {
  const root = temporary(), input = { departmentId: 'd', businessDate: '2026-08-28', cursor: '', limit: 100 }
  try {
    await assert.rejects(new QxmEvidenceProcessTransport({ executablePath: executable(root, `process.exit(42)`, 'expired.mjs') }).readMessages(input), QxmEvidenceSessionExpiredError)
    await assert.rejects(new QxmEvidenceProcessTransport({ executablePath: executable(root, `process.exit(43)`, 'source-timeout.mjs') }).readMessages(input), /源接口读取超过受控时限/)
    const slow = executable(root, `setTimeout(()=>process.stdout.write(JSON.stringify({rows:[],total:0,nextCursor:'',hasMore:false})),10000)`, 'slow.mjs')
    await assert.rejects(new QxmEvidenceProcessTransport({ executablePath: slow, timeoutMs: 1000 }).readMessages(input), /超时/)
    const controller = new AbortController(), pending = new QxmEvidenceProcessTransport({ executablePath: slow, timeoutMs: 10000 }).readMessages(input, controller.signal); controller.abort(); await assert.rejects(pending, /已取消/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
