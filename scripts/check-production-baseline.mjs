import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function assetReferences(html) {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
}

async function fetchBuffer(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

export async function inspectProductionBaseline({ fetchImpl = fetch } = {}) {
  const baseline = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/production-baseline.json'), 'utf8'))
  const mirrorIndex = fs.readFileSync(path.join(repositoryRoot, baseline.mirrorIndex))
  const productionIndex = await fetchBuffer(`${baseline.origin}/`, fetchImpl)
  const references = assetReferences(productionIndex.toString('utf8'))

  const remoteAssets = []
  for (const entrypoint of baseline.entrypoints) {
    const present = entrypoint.direct === false || references.includes(entrypoint.reference)
    if (!present) {
      remoteAssets.push({ reference: entrypoint.reference, present: false, sha256: null, ok: false })
      continue
    }
    const contents = await fetchBuffer(new URL(entrypoint.reference, `${baseline.origin}/`), fetchImpl)
    const actual = sha256(contents)
    remoteAssets.push({
      reference: entrypoint.reference,
      present: true,
      sha256: actual,
      expectedSha256: entrypoint.sha256,
      ok: actual === entrypoint.sha256,
    })
  }

  const localArtifacts = baseline.localArtifacts.map(artifact => {
    const file = path.join(repositoryRoot, artifact.path)
    const exists = fs.existsSync(file)
    const actual = exists ? sha256(fs.readFileSync(file)) : null
    return {
      reference: artifact.reference,
      path: artifact.path,
      exists,
      sha256: actual,
      expectedSha256: artifact.sha256,
      ok: exists && actual === artifact.sha256,
    }
  })

  const productionSha256 = sha256(productionIndex)
  const mirrorSha256 = sha256(mirrorIndex)
  const result = {
    origin: baseline.origin,
    release: baseline.release,
    expected: {
      indexSha256: baseline.indexSha256,
      entrypointCount: baseline.entrypoints.length,
      mirrorIndex: baseline.mirrorIndex,
    },
    actual: {
      indexSha256: productionSha256,
      mirrorIndexSha256: mirrorSha256,
      referencedAssetCount: references.length,
      remoteAssets,
      localArtifacts,
    },
  }
  result.ok = productionSha256 === baseline.indexSha256
    && mirrorSha256 === productionSha256
    && remoteAssets.every(asset => asset.ok)
    && localArtifacts.every(artifact => artifact.ok)
  return result
}

async function main() {
  const result = await inspectProductionBaseline()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (process.argv.includes('--strict') && !result.ok) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
