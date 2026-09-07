import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendDir = path.join(repoRoot, 'review-system/active/backend')
const serverPath = path.join(backendDir, 'server.js')
const bootstrapPassword = 'UnitTest-Store!2026-Secure'

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise(resolve => server.close(resolve))
  return address.port
}

function startServer(dataDir, port) {
  let stdout = ''
  let stderr = ''
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      STORE_FILE: path.join(dataDir, 'store.json'),
      FILES_DIR: path.join(dataDir, 'files'),
      BACKUPS_DIR: path.join(dataDir, 'backups'),
      BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
      REVIEW_SSO_SECRET: 'unit-test-review-sso-secret-at-least-32-bytes'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return {
    child,
    output: () => ({ stdout, stderr })
  }
}

async function waitForExit(runtime, timeoutMs = 90_000) {
  const { child } = runtime
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`等待服务进程退出超时：${JSON.stringify(runtime.output())}`))
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function waitForHealth(runtime, port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/api/health`
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`服务在 health 就绪前退出：${JSON.stringify(runtime.output())}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`等待 health 超时：${JSON.stringify(runtime.output())}`)
}

async function waitForReadyOrExit(runtime, port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  const url = `http://127.0.0.1:${port}/api/health`
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      return { status: 'exited', code: runtime.child.exitCode, signal: runtime.child.signalCode }
    }
    try {
      const response = await fetch(url)
      if (response.ok) return { status: 'healthy' }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`等待并发服务就绪超时：${JSON.stringify(runtime.output())}`)
}

async function stopServer(runtime) {
  const { child } = runtime
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForExit(runtime, 5_000)
  } catch {
    child.kill('SIGKILL')
    await waitForExit(runtime, 5_000)
  }
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function withTempStore(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'review-store-startup-'))
  try {
    await run({ dataDir, storeFile: path.join(dataDir, 'store.json') })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
}

test('损坏的存量 store 使真实服务 fail-fast，且原文件不变', async () => {
  await withTempStore(async ({ dataDir, storeFile }) => {
    await writeFile(storeFile, '{"users": [', { mode: 0o600 })
    const beforeHash = await sha256(storeFile)
    const runtime = startServer(dataDir, await freePort())
    let result
    try {
      result = await waitForExit(runtime)
    } finally {
      await stopServer(runtime)
    }

    assert.notEqual(result.code, 0, '损坏 store 不得启动成功')
    assert.match(runtime.output().stderr, /JSON 解析失败|拒绝启动/)
    assert.equal(await sha256(storeFile), beforeHash)
  })
})

test('超过12MiB的单链接普通 store 在读入前 fail-fast，且字节与元数据不变', async () => {
  await withTempStore(async ({ dataDir, storeFile }) => {
    await writeFile(storeFile, Buffer.alloc(12 * 1024 * 1024 + 1, 0x20), { mode: 0o600 })
    const beforeHash = await sha256(storeFile)
    const beforeStat = await stat(storeFile, { bigint: true })
    const runtime = startServer(dataDir, await freePort())
    let result
    try {
      result = await waitForExit(runtime)
    } finally {
      await stopServer(runtime)
    }

    assert.notEqual(result.code, 0, '超大 store 不得启动成功')
    assert.match(runtime.output().stderr, /超出 12MB 可备份上限，拒绝读入与启动/)
    const afterStat = await stat(storeFile, { bigint: true })
    assert.equal(await sha256(storeFile), beforeHash)
    assert.equal(afterStat.ino, beforeStat.ino)
    assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs)
    assert.equal(afterStat.size, beforeStat.size)
  })
})

test('结构错误的存量 store 使真实服务 fail-fast，且不被默认数据覆写', async () => {
  await withTempStore(async ({ dataDir, storeFile }) => {
    await writeFile(storeFile, JSON.stringify({ users: [] }), { mode: 0o600 })
    const beforeHash = await sha256(storeFile)
    const runtime = startServer(dataDir, await freePort())
    let result
    try {
      result = await waitForExit(runtime)
    } finally {
      await stopServer(runtime)
    }

    assert.notEqual(result.code, 0, '结构错误的 store 不得启动成功')
    assert.match(runtime.output().stderr, /字段 proposals 必须是数组|拒绝启动/)
    assert.equal(await sha256(storeFile), beforeHash)
  })
})

test('首次启动仅在 store ENOENT 时初始化有效 JSON', async () => {
  await withTempStore(async ({ dataDir, storeFile }) => {
    const port = await freePort()
    const runtime = startServer(dataDir, port)
    try {
      await waitForHealth(runtime, port)
    } finally {
      await stopServer(runtime)
    }

    const parsed = JSON.parse(await readFile(storeFile, 'utf8'))
    for (const field of ['users', 'proposals', 'logs', 'rules', 'knowledgeEntries', 'botProfiles']) {
      assert.ok(Array.isArray(parsed[field]), `${field} 必须是数组`)
    }
    for (const field of ['reminderConfig', 'rolePermissions', 'systemConfig']) {
      assert.ok(parsed[field] && typeof parsed[field] === 'object' && !Array.isArray(parsed[field]))
    }
    assert.equal((await stat(storeFile)).mode & 0o777, 0o600)
    assert.deepEqual(
      (await readdir(dataDir)).filter(name => name.includes('.tmp')),
      [],
      '首次初始化不应遗留临时文件'
    )
  })
})

test('正常存量 store 重启时不写盘，hash、inode 与修改时间不变', async () => {
  await withTempStore(async ({ dataDir, storeFile }) => {
    const firstPort = await freePort()
    const firstRuntime = startServer(dataDir, firstPort)
    try {
      await waitForHealth(firstRuntime, firstPort)
    } finally {
      await stopServer(firstRuntime)
    }

    const beforeHash = await sha256(storeFile)
    const beforeStat = await stat(storeFile, { bigint: true })
    const secondPort = await freePort()
    const secondRuntime = startServer(dataDir, secondPort)
    try {
      await waitForHealth(secondRuntime, secondPort)
    } finally {
      await stopServer(secondRuntime)
    }

    const afterStat = await stat(storeFile, { bigint: true })
    assert.equal(await sha256(storeFile), beforeHash)
    assert.equal(afterStat.ino, beforeStat.ino, '启动期间不得原子替换存量 store')
    assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs, '启动期间不得改写存量 store')
  })
})

test('两个真实服务并发启动时最多一个初始化者，且不留临时文件', async () => {
  await withTempStore(async ({ dataDir, storeFile }) => {
    const firstPort = await freePort()
    let secondPort = await freePort()
    while (secondPort === firstPort) secondPort = await freePort()
    const firstRuntime = startServer(dataDir, firstPort)
    const secondRuntime = startServer(dataDir, secondPort)

    try {
      const results = await Promise.all([
        waitForReadyOrExit(firstRuntime, firstPort),
        waitForReadyOrExit(secondRuntime, secondPort)
      ])
      assert.ok(results.some(result => result.status === 'healthy'), '至少一个服务应成功使用已发布的 store')
    } finally {
      await Promise.all([stopServer(firstRuntime), stopServer(secondRuntime)])
    }

    const initializationCount = [firstRuntime, secondRuntime]
      .map(runtime => runtime.output().stdout.match(/数据文件首次初始化完成/g)?.length || 0)
      .reduce((sum, count) => sum + count, 0)
    assert.equal(initializationCount, 1, '共享空目录只能有一个成功初始化者')

    const parsed = JSON.parse(await readFile(storeFile, 'utf8'))
    assert.ok(Array.isArray(parsed.users) && parsed.users.length > 0)
    assert.deepEqual((await readdir(dataDir)).filter(name => name.includes('.tmp')), [])
  })
})

test('首次初始化合同包含 no-replace 发布、同目录临时文件和持久化门禁', async () => {
  const source = await readFile(serverPath, 'utf8')
  assert.match(source, /fs\.linkSync\(prepared\.path, storeFile\)/)
  assert.match(source, /installedMode !== 0o600/)
  assert.match(source, /fs\.renameSync\(prepared\.path, storeFile\)/)
  assert.match(source, /fs\.fsyncSync\(fd\)/)
  assert.match(source, /function syncStoreDirectory\(\)/)
  assert.match(source, /首次初始化期间检测到并发创建，已拒绝覆盖/)
})
