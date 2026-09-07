import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { Header } from '../review-system/active/backend/node_modules/tar/dist/esm/index.js'
import {
  BACKUP_ARCHIVE_SCHEMA,
  BACKUP_ARCHIVE_SUFFIX,
  BACKUP_ARCHIVE_VERSION,
  BACKUP_ARCHIVE_LIMITS,
  createBackupArchive,
  openBackupArchiveForRead,
  previewBackupArchive,
  restoreBackupArchive
} from '../review-system/active/backend/backup-archive.js'

const MiB = 1024 * 1024

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function archiveEntryPath(name) {
  return `files/${sha256(Buffer.from(name, 'utf8'))}`
}

function compareUtf8Names(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-backup-archive-'))
  const filesDir = path.join(root, 'files')
  await mkdir(filesDir, { mode: 0o700 })
  try {
    await run({
      root,
      filesDir,
      archivePath: path.join(root, `backup${BACKUP_ARCHIVE_SUFFIX}`),
      stage: path.join(root, 'stage')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function manifestFor(storeBuffer, fileItems = []) {
  const files = [...fileItems]
    .sort((left, right) => compareUtf8Names(left.name, right.name))
    .map(item => ({
      name: item.name,
      path: archiveEntryPath(item.name),
      size: item.content.length,
      sha256: item.sha256 || sha256(item.content),
      mtimeMs: item.mtimeMs ?? 0
    }))
  return {
    schema: BACKUP_ARCHIVE_SCHEMA,
    version: BACKUP_ARCHIVE_VERSION,
    createdAt: '2026-08-13T00:00:00.000Z',
    store: {
      path: 'store.json',
      size: storeBuffer.length,
      sha256: sha256(storeBuffer)
    },
    files,
    totals: {
      fileCount: files.length,
      fileBytes: files.reduce((sum, item) => sum + item.size, 0),
      storeBytes: storeBuffer.length
    }
  }
}

function rawTarEntry({ entryPath, content = Buffer.alloc(0), type = 'File', linkpath }) {
  const size = /^(?:File|OldFile|ContiguousFile|ExtendedHeader|OldExtendedHeader|GlobalExtendedHeader)$/u.test(type)
    ? content.length
    : 0
  const header = new Header({
    path: entryPath,
    type,
    linkpath,
    size,
    mode: type === 'Directory' ? 0o700 : 0o600,
    uid: 0,
    gid: 0,
    mtime: new Date(0)
  })
  header.encode()
  const padding = Buffer.alloc((512 - (size % 512)) % 512)
  return Buffer.concat([header.block, content.subarray(0, size), padding])
}

function rawUnknownTypeEntry(entryPath) {
  const encoded = rawTarEntry({ entryPath })
  const header = encoded.subarray(0, 512)
  header[156] = 'Z'.charCodeAt(0)
  header.fill(0x20, 148, 156)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return encoded
}

function archiveBuffer(entries) {
  return gzipSync(Buffer.concat([
    ...entries.map(rawTarEntry),
    Buffer.alloc(1024)
  ]))
}

async function writeArchive(archivePath, entries) {
  await writeFile(archivePath, archiveBuffer(entries), { mode: 0o600 })
}

function canonicalEntries(storeBuffer, fileItems = []) {
  const manifest = manifestFor(storeBuffer, fileItems)
  return [
    { entryPath: 'manifest.json', content: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { entryPath: 'store.json', content: storeBuffer },
    ...[...fileItems]
      .sort((left, right) => compareUtf8Names(left.name, right.name))
      .map(item => ({ entryPath: archiveEntryPath(item.name), content: item.content }))
  ]
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`
  let length = Buffer.byteLength(body) + 2
  while (true) {
    const record = `${length} ${body}`
    const actual = Buffer.byteLength(record)
    if (actual === length) return Buffer.from(record)
    length = actual
  }
}

test('近自定义库存上限的附件可流式导出、预览和安全解包', async () => {
  await withFixture(async ({ filesDir, archivePath, stage }) => {
    const attachment = crypto.randomBytes(8 * MiB - 4096)
    await writeFile(path.join(filesDir, '近容量上限.bin'), attachment, { mode: 0o600 })
    const longUnicodeName = `${'审'.repeat(70)}.txt`
    await writeFile(path.join(filesDir, longUnicodeName), '长 UTF-8 名称往返', { mode: 0o600 })
    const storeBuffer = Buffer.from(JSON.stringify({ users: [], proposals: [], marker: '流式备份' }))
    const limits = {
      maxAttachmentBytes: 8 * MiB,
      maxFileCount: 10,
      maxStoreBytes: MiB,
      maxManifestBytes: MiB,
      maxArchiveBytes: 9 * MiB,
      maxTarBytes: 9 * MiB,
      readChunkBytes: 64 * 1024
    }

    const created = await createBackupArchive({ archivePath, storeBuffer, filesDir, limits })
    assert.equal(created.files.length, 2)
    assert.equal(created.totals.fileBytes, attachment.length + Buffer.byteLength('长 UTF-8 名称往返'))
    assert.ok(created.files.every(item => /^files\/[a-f0-9]{64}$/u.test(item.path)))
    assert.ok(created.archiveBytes > 0)

    const preview = await previewBackupArchive({ archivePath, limits })
    assert.equal(preview.store.marker, '流式备份')
    assert.ok(preview.files.some(item => item.sha256 === sha256(attachment)))

    await mkdir(stage, { mode: 0o700 })
    const restored = await restoreBackupArchive({ archivePath, stagingDir: stage, limits })
    const restoredPath = path.join(stage, 'files', '近容量上限.bin')
    assert.equal(sha256(await readFile(restoredPath)), sha256(attachment))
    assert.equal(await readFile(path.join(stage, 'files', longUnicodeName), 'utf8'), '长 UTF-8 名称往返')
    assert.equal((await stat(restoredPath)).mode & 0o777, 0o600)
    assert.equal((await stat(path.join(stage, 'files'))).mode & 0o777, 0o700)
    assert.deepEqual(restored.store, JSON.parse(storeBuffer))
  })
})

test('模块硬上界覆盖 server 可配置的 20GiB 库存', () => {
  assert.ok(BACKUP_ARCHIVE_LIMITS.maxAttachmentBytes >= 20 * 1024 ** 3)
  assert.ok(BACKUP_ARCHIVE_LIMITS.maxArchiveBytes > BACKUP_ARCHIVE_LIMITS.maxAttachmentBytes)
  assert.ok(BACKUP_ARCHIVE_LIMITS.maxTarBytes > BACKUP_ARCHIVE_LIMITS.maxAttachmentBytes)
})

test('生成端的 gzip 存储模式保证高重复合法附件仍可自洽预览', async () => {
  await withFixture(async ({ filesDir, archivePath }) => {
    const content = Buffer.alloc(2 * MiB)
    await writeFile(path.join(filesDir, 'zeros.bin'), content, { mode: 0o600 })
    const created = await createBackupArchive({ archivePath, storeBuffer: '{}', filesDir })
    assert.ok(created.archiveBytes > content.length, '存储模式归档应保留近似原始体积')
    const preview = await previewBackupArchive({ archivePath })
    assert.equal(preview.files[0].sha256, sha256(content))
  })
})

test('读取端拒绝可改写路径的恶意 PAX 扩展字段', async () => {
  await withFixture(async ({ archivePath }) => {
    const store = Buffer.from('{}')
    await writeArchive(archivePath, [
      {
        entryPath: 'pax-header',
        type: 'ExtendedHeader',
        content: Buffer.concat([
          paxRecord('path', '../outside'),
          paxRecord('size', '999999999')
        ])
      },
      ...canonicalEntries(store)
    ])
    await assert.rejects(previewBackupArchive({ archivePath }), /扩展元数据/)
  })
})

test('导出拒绝附件 symlink 与 hardlink', async () => {
  await withFixture(async ({ filesDir, archivePath }) => {
    const outside = path.join(path.dirname(filesDir), 'outside.txt')
    await writeFile(outside, 'outside')
    await fs.promises.symlink(outside, path.join(filesDir, 'link.txt'))
    await assert.rejects(
      createBackupArchive({ archivePath, storeBuffer: '{}', filesDir }),
      /单链接普通文件/
    )

    await rm(path.join(filesDir, 'link.txt'))
    const first = path.join(filesDir, 'first.txt')
    const second = path.join(filesDir, 'second.txt')
    await writeFile(first, 'same inode')
    await fs.promises.link(first, second)
    await assert.rejects(
      createBackupArchive({ archivePath, storeBuffer: '{}', filesDir }),
      /单链接普通文件/
    )
  })
})

test('导出在流式处理前执行 store 字节与附件数量上限', async () => {
  await withFixture(async ({ filesDir, archivePath }) => {
    await writeFile(path.join(filesDir, 'one.txt'), '1')
    await writeFile(path.join(filesDir, 'two.txt'), '2')
    await assert.rejects(
      createBackupArchive({ archivePath, storeBuffer: '{}', filesDir, limits: { maxFileCount: 1 } }),
      /附件数量超出 1 个上限/
    )
    await rm(path.join(filesDir, 'two.txt'))
    await assert.rejects(
      createBackupArchive({ archivePath, storeBuffer: '{"too":"large"}', filesDir, limits: { maxStoreBytes: 4 } }),
      /store\.json 超出 4 字节上限/
    )
  })
})

test('读取端拒绝 path traversal、绝对路径、嵌套路径与额外条目', async () => {
  const badPaths = ['../escape', '/absolute', 'files/sub/nested.txt', 'unexpected.txt']
  for (const badPath of badPaths) {
    await withFixture(async ({ archivePath }) => {
      const store = Buffer.from('{}')
      await writeArchive(archivePath, [
        ...canonicalEntries(store),
        { entryPath: badPath, content: Buffer.from('escape') }
      ])
      await assert.rejects(previewBackupArchive({ archivePath }), /额外|嵌套|路径不安全/)
    })
  }
})

test('读取端拒绝重复条目与多余附件', async () => {
  await withFixture(async ({ archivePath }) => {
    const store = Buffer.from('{}')
    const file = { name: 'same.txt', content: Buffer.from('same') }
    const entries = canonicalEntries(store, [file])
    await writeArchive(archivePath, [...entries, entries.at(-1)])
    await assert.rejects(previewBackupArchive({ archivePath }), /重复/)
  })
})

test('读取端拒绝 manifest 声明但归档缺失的附件', async () => {
  await withFixture(async ({ archivePath }) => {
    const store = Buffer.from('{}')
    const declared = { name: 'missing.txt', content: Buffer.from('declared only') }
    await writeArchive(archivePath, canonicalEntries(store, [declared]).slice(0, 2))
    await assert.rejects(previewBackupArchive({ archivePath }), /附件集合与 manifest 不完整对应/)
  })
})

test('读取端拒绝 tar EOF 后隐藏的连接 gzip 归档', async () => {
  await withFixture(async ({ archivePath }) => {
    const store = Buffer.from('{}')
    const valid = archiveBuffer(canonicalEntries(store))
    const hidden = archiveBuffer([{ entryPath: 'hidden.txt', content: Buffer.from('hidden') }])
    await writeFile(archivePath, Buffer.concat([valid, hidden]), { mode: 0o600 })
    await assert.rejects(previewBackupArchive({ archivePath }), /完整结束标记后包含额外/)
  })
})

test('读取端拒绝 symlink、hardlink 和设备条目', async () => {
  for (const malicious of [
    { type: 'SymbolicLink', linkpath: '../../escape' },
    { type: 'Link', linkpath: 'store.json' },
    { type: 'CharacterDevice' }
  ]) {
    await withFixture(async ({ archivePath }) => {
      const store = Buffer.from('{}')
      await writeArchive(archivePath, [
        ...canonicalEntries(store),
        { entryPath: 'files/unsafe', ...malicious }
      ])
      await assert.rejects(previewBackupArchive({ archivePath }), /拒绝 .* 条目/)
    })
  }
})

test('读取端拒绝 tar parser 默认忽略的未知类型条目', async () => {
  await withFixture(async ({ archivePath }) => {
    const store = Buffer.from('{}')
    const rawTar = Buffer.concat([
      ...canonicalEntries(store).map(rawTarEntry),
      rawUnknownTypeEntry('hidden-unknown'),
      Buffer.alloc(1024)
    ])
    await writeFile(archivePath, gzipSync(rawTar), { mode: 0o600 })
    await assert.rejects(previewBackupArchive({ archivePath }), /不支持或被忽略/)
  })
})

test('附件 hash 错误时 restore 失败关闭并清空 staging', async () => {
  await withFixture(async ({ archivePath, stage }) => {
    const store = Buffer.from('{"safe":true}')
    const file = { name: 'bad.txt', content: Buffer.from('actual'), sha256: '0'.repeat(64) }
    await writeArchive(archivePath, canonicalEntries(store, [file]))
    await mkdir(stage, { mode: 0o700 })
    await assert.rejects(
      restoreBackupArchive({ archivePath, stagingDir: stage }),
      /附件校验和不一致/
    )
    assert.deepEqual(await readdir(stage), [], '失败恢复不得留下半成品')
  })
})

test('解压 tar 绝对字节上限拦截高压缩比输入', async () => {
  await withFixture(async ({ archivePath }) => {
    const compressedBomb = archiveBuffer([
      { entryPath: 'manifest.json', content: Buffer.alloc(256 * 1024, 0x20) }
    ])
    assert.ok(compressedBomb.length < 4096, '测试数据应为高压缩比')
    await writeFile(archivePath, compressedBomb, { mode: 0o600 })
    await assert.rejects(
      previewBackupArchive({
        archivePath,
        limits: {
          maxManifestBytes: 512 * 1024,
          maxTarBytes: 4096,
          maxArchiveBytes: MiB
        }
      }),
      /解压 tar 流超出/
    )
  })
})

test('manifest 完成后、附件正文解压前拦截压缩比炸弹', async () => {
  await withFixture(async ({ archivePath }) => {
    const store = Buffer.from('{}')
    const bomb = { name: 'ratio-bomb.bin', content: Buffer.alloc(8 * MiB) }
    await writeArchive(archivePath, canonicalEntries(store, [bomb]))
    await assert.rejects(
      previewBackupArchive({
        archivePath,
        limits: {
          maxAttachmentBytes: 9 * MiB,
          maxArchiveBytes: 9 * MiB,
          maxTarBytes: 9 * MiB
        }
      }),
      /解压比超出 4:1/
    )
  })
})

test('过大声明附件在写入 staging 前被拒绝', async () => {
  await withFixture(async ({ archivePath, stage }) => {
    const store = Buffer.from('{}')
    const bomb = { name: 'bomb.bin', content: Buffer.alloc(2 * MiB) }
    await writeArchive(archivePath, canonicalEntries(store, [bomb]))
    await mkdir(stage, { mode: 0o700 })
    await assert.rejects(
      restoreBackupArchive({
        archivePath,
        stagingDir: stage,
        limits: { maxAttachmentBytes: MiB, maxTarBytes: 4 * MiB, maxArchiveBytes: 4 * MiB }
      }),
      /超出允许范围|附件总量超出/
    )
    assert.deepEqual(await readdir(stage), [])
  })
})

test('归档失败不破坏旧文件且不留临时文件', async () => {
  await withFixture(async ({ root, filesDir, archivePath }) => {
    const oldContent = Buffer.from('old archive remains intact')
    await writeFile(archivePath, oldContent, { mode: 0o600 })
    await writeFile(path.join(filesDir, 'random.bin'), crypto.randomBytes(2 * MiB), { mode: 0o600 })

    await assert.rejects(
      createBackupArchive({
        archivePath,
        storeBuffer: '{}',
        filesDir,
        replaceExisting: true,
        limits: {
          maxAttachmentBytes: 3 * MiB,
          maxArchiveBytes: 1024,
          maxTarBytes: 4 * MiB,
          readChunkBytes: 64 * 1024
        }
      }),
      /压缩归档超出/
    )
    assert.deepEqual(await readFile(archivePath), oldContent)
    assert.deepEqual(
      (await readdir(root)).filter(name => name.includes('.tmp')),
      [],
      '失败生成不得留下临时归档'
    )
  })
})

test('已中断的生成请求不创建任何归档半成品', async () => {
  await withFixture(async ({ root, filesDir, archivePath }) => {
    const controller = new AbortController()
    controller.abort(new Error('单元测试中断'))
    await assert.rejects(
      createBackupArchive({ archivePath, storeBuffer: '{}', filesDir, signal: controller.signal }),
      /单元测试中断/
    )
    assert.equal(fs.existsSync(archivePath), false)
    assert.deepEqual((await readdir(root)).filter(name => name.includes('.tmp')), [])
  })
})

test('运行中中断流式生成会清理临时文件', async () => {
  await withFixture(async ({ root, filesDir, archivePath }) => {
    await writeFile(path.join(filesDir, 'large.bin'), crypto.randomBytes(16 * MiB), { mode: 0o600 })
    const controller = new AbortController()
    const operation = createBackupArchive({
      archivePath,
      storeBuffer: '{}',
      filesDir,
      signal: controller.signal,
      limits: {
        maxAttachmentBytes: 20 * MiB,
        maxArchiveBytes: 20 * MiB,
        maxTarBytes: 20 * MiB,
        readChunkBytes: 4096
      }
    })
    setTimeout(() => controller.abort(new Error('运行中中断')), 1)
    await assert.rejects(operation, /运行中中断|aborted/i)
    assert.equal(fs.existsSync(archivePath), false)
    assert.deepEqual((await readdir(root)).filter(name => name.includes('.tmp')), [])
  })
})

test('一次性读取 lease 固定 FD，路径被替换后仍只交付原归档', async () => {
  await withFixture(async ({ root, filesDir, archivePath }) => {
    await writeFile(path.join(filesDir, 'lease.txt'), 'fixed descriptor', { mode: 0o600 })
    await createBackupArchive({ archivePath, storeBuffer: '{}', filesDir })
    const original = await readFile(archivePath)
    const lease = openBackupArchiveForRead({ archivePath })
    const moved = path.join(root, `moved${BACKUP_ARCHIVE_SUFFIX}`)
    await fs.promises.rename(archivePath, moved)
    await writeFile(archivePath, 'attacker replacement', { mode: 0o600 })

    const chunks = []
    for await (const chunk of lease.createReadStream()) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), original)
    assert.throws(() => lease.createReadStream(), /lease 已被消费/)
    lease.close()
  })
})

test('preview/restore 接受不保留业务扩展名的上传临时路径', async () => {
  await withFixture(async ({ root, filesDir, archivePath, stage }) => {
    await writeFile(path.join(filesDir, 'upload.txt'), 'temporary upload')
    await createBackupArchive({ archivePath, storeBuffer: '{"upload":true}', filesDir })
    const uploadPath = path.join(root, 'multer-upload-opaque.tmp')
    await fs.promises.rename(archivePath, uploadPath)
    assert.equal((await previewBackupArchive({ archivePath: uploadPath })).store.upload, true)
    await mkdir(stage, { mode: 0o700 })
    await restoreBackupArchive({ archivePath: uploadPath, stagingDir: stage })
    assert.equal(await readFile(path.join(stage, 'files', 'upload.txt'), 'utf8'), 'temporary upload')
  })
})

test('输入归档自身为 symlink 或 hardlink 时拒绝读取', async () => {
  await withFixture(async ({ root, archivePath }) => {
    const store = Buffer.from('{}')
    const realArchive = path.join(root, `real${BACKUP_ARCHIVE_SUFFIX}`)
    await writeArchive(realArchive, canonicalEntries(store))

    await fs.promises.symlink(realArchive, archivePath)
    await assert.rejects(previewBackupArchive({ archivePath }), /单链接普通文件/)
    await rm(archivePath)

    await fs.promises.link(realArchive, archivePath)
    await assert.rejects(previewBackupArchive({ archivePath }), /单链接普通文件/)
  })
})
