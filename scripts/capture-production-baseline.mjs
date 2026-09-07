import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Map(process.argv.slice(2).map((value, index, all) => value.startsWith('--') ? [value, all[index + 1]] : null).filter(Boolean))
const origin = String(args.get('--origin') || 'https://www.firstcare.cloud').replace(/\/$/, '')
const release = String(args.get('--release') || '').trim()
const output = String(args.get('--output') || '').trim()
if (!release || !output) throw new Error('用法：node scripts/capture-production-baseline.mjs --release <名称> --output <目录> [--origin <地址>]')

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const outputRoot = path.resolve(root, output)
const payloadRoot = path.join(outputRoot, 'payload')
const indexResponse = await fetch(`${origin}/`, { redirect: 'follow' })
if (!indexResponse.ok) throw new Error(`生产入口返回 HTTP ${indexResponse.status}`)
const index = Buffer.from(await indexResponse.arrayBuffer())
const html = index.toString('utf8')
const initialReferences = [...new Set([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]))]

await fs.rm(outputRoot, { recursive: true, force: true })
await fs.mkdir(payloadRoot, { recursive: true })
await fs.writeFile(path.join(payloadRoot, 'index.html'), index)
const entrypoints = []
const localArtifacts = []
const pathHashes = new Map()
const seenUrls = new Set()
const queue = initialReferences.map(reference => ({ reference, base: `${origin}/`, direct: true }))
while (queue.length) {
  const item = queue.shift()
  const url = new URL(item.reference, item.base)
  if (url.origin !== origin || url.pathname.endsWith('/') || seenUrls.has(url.href)) continue
  if (!item.direct && !/\.(?:m?js|css|wasm|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i.test(url.pathname)) continue
  seenUrls.add(url.href)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${url.href} 返回 HTTP ${response.status}`)
  const contents = Buffer.from(await response.arrayBuffer())
  const digest = sha256(contents)
  const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (!relative || relative.includes('..')) throw new Error(`非法静态资源路径：${reference}`)
  const previous = pathHashes.get(relative)
  if (previous && previous !== digest) throw new Error(`同一路径出现不同内容：${relative}`)
  pathHashes.set(relative, digest)
  const target = path.join(payloadRoot, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
  const reference = item.direct ? item.reference : `${url.pathname}${url.search}`
  entrypoints.push({ reference, sha256: digest, direct: item.direct })
  localArtifacts.push({ reference, path: path.relative(root, target), sha256: digest })

  const contentType = String(response.headers.get('content-type') || '')
  const text = contents.toString('utf8')
  const dependencies = []
  if (/javascript|ecmascript/.test(contentType) || /\.m?js$/.test(url.pathname)) {
    dependencies.push(...[...text.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)].map(match => match[1]))
  }
  if (/text\/css/.test(contentType) || /\.css$/.test(url.pathname)) {
    dependencies.push(...[...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(match => match[1]))
    dependencies.push(...[...text.matchAll(/@import\s+["']([^"']+)["']/g)].map(match => match[1]))
  }
  dependencies.filter(value => !/^(?:data:|blob:|#)/.test(value)).forEach(value => queue.push({ reference: value, base: url.href, direct: false }))
}

const capturedAt = new Date().toISOString()
const baseline = {
  schemaVersion: 3,
  capturedAt,
  origin,
  release,
  indexSha256: sha256(index),
  mirrorIndex: path.relative(root, path.join(payloadRoot, 'index.html')),
  entrypoints,
  localArtifacts,
  protectedRoutes: ['/daily', '/payment', '/collection', '/projects', '/review', '/admin'],
  sourceStatus: {
    rebuildable: true,
    strategy: 'immutable-production-snapshot',
    backend: 'TypeScript source + package-lock.json + Node 20 clean build',
    frontend: `${release} immutable static payload captured from the active production lineage`,
  },
}
await fs.writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify({ release, capturedAt, indexSha256: baseline.indexSha256, files: localArtifacts }, null, 2)}\n`)
await fs.mkdir(path.join(root, 'config'), { recursive: true })
await fs.writeFile(path.join(root, 'config/production-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`)
console.log(JSON.stringify({ release, output: path.relative(root, outputRoot), indexSha256: baseline.indexSha256, assets: entrypoints.length }, null, 2))
