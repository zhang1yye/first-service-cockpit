#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const cockpitDir = join(root, 'firstcare-cloud-local')
const distDir = join(root, 'review-system/active/frontend/dist')
const port = Number(process.env.SHADOW_PORT || 3851)
const upstream = 'https://firstcare.cloud'

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

function localAsset(base, requestPath) {
  const relative = requestPath.replace(/^\/+/, '')
  const target = normalize(join(base, relative))
  if (!target.startsWith(`${normalize(base)}/`)) throw new Error('静态路径越界')
  return target
}

async function bodyBuffer(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function proxy(request, response, pathname, { rewriteSso = false } = {}) {
  const body = ['GET', 'HEAD'].includes(request.method || 'GET') ? undefined : await bodyBuffer(request)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (!value || ['host', 'content-length', 'connection'].includes(name.toLowerCase())) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  const upstreamResponse = await fetch(`${upstream}${pathname}`, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
  })

  if (rewriteSso) {
    const payload = await upstreamResponse.json()
    if (payload?.url) {
      const target = new URL(payload.url, upstream)
      payload.url = `http://127.0.0.1:${port}${target.pathname}${target.search}${target.hash}`
    }
    response.writeHead(upstreamResponse.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(payload))
    return
  }

  const outgoingHeaders = {}
  for (const [name, value] of upstreamResponse.headers.entries()) {
    if (['content-encoding', 'content-length', 'connection', 'transfer-encoding'].includes(name)) continue
    outgoingHeaders[name] = value
  }
  response.writeHead(upstreamResponse.status, outgoingHeaders)
  response.end(Buffer.from(await upstreamResponse.arrayBuffer()))
}

async function sendFile(response, target, { transformIndex = false } = {}) {
  const info = await stat(target)
  if (!info.isFile()) throw new Error('目标不是文件')
  const headers = {
    'content-type': contentTypes[extname(target)] || 'application/octet-stream',
    'cache-control': transformIndex ? 'no-store' : 'public, max-age=60',
  }
  if (transformIndex) {
    const html = (await readFile(target, 'utf8'))
      .replaceAll('src="/assets/', 'src="/review-system/assets/')
      .replaceAll('href="/assets/', 'href="/review-system/assets/')
    response.writeHead(200, headers)
    response.end(html)
    return
  }
  response.writeHead(200, { ...headers, 'content-length': info.size })
  createReadStream(target).pipe(response)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
    if (url.pathname === '/review') {
      await sendFile(response, join(cockpitDir, 'review-launcher.html'))
      return
    }
    if (url.pathname === '/review-launcher-20260812-v1.js' || url.pathname === '/review-launcher-20260812-v1.css') {
      await sendFile(response, localAsset(cockpitDir, url.pathname))
      return
    }
    if (url.pathname === '/api/integrations/review/sso') {
      await proxy(request, response, `${url.pathname}${url.search}`, { rewriteSso: true })
      return
    }
    if (url.pathname.startsWith('/review-api/')) {
      await proxy(request, response, `${url.pathname}${url.search}`)
      return
    }
    if (url.pathname === '/review-system') {
      response.writeHead(308, { location: `/review-system/${url.search}` })
      response.end()
      return
    }
    if (url.pathname.startsWith('/review-system/assets/')) {
      const relative = url.pathname.slice('/review-system/'.length)
      await sendFile(response, localAsset(distDir, relative))
      return
    }
    if (url.pathname.startsWith('/review-system/')) {
      await sendFile(response, join(distDir, 'index.html'), { transformIndex: true })
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not Found')
  } catch (error) {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ message: error?.message || '影子服务失败' }))
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ ok: true, port, mode: 'read-only-shadow' }) + '\n')
})
