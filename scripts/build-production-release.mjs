import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : '' }
const outputArg = arg('--output')
if (!outputArg) throw new Error('用法：node scripts/build-production-release.mjs --output <候选目录>')
const output = path.resolve(root, outputArg)
const sourceCommit = String(process.env.COCKPIT_SOURCE_COMMIT || '').trim().toLowerCase()
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('COCKPIT_SOURCE_COMMIT must be an explicit 40-character git commit SHA')
const baseline = JSON.parse(await fs.readFile(path.join(root, 'config/production-baseline.json'), 'utf8'))
const runtime = JSON.parse(await fs.readFile(path.join(root, 'config/production-runtime-r127.json'), 'utf8'))
const expectedProductionIndexSha256 = runtime.frontend?.indexSha256
if (!/^[a-f0-9]{64}$/.test(expectedProductionIndexSha256 || '')) throw new Error('当前生产前端入口哈希缺失或非法')
const sourcePayload = path.join(root, path.dirname(baseline.mirrorIndex))
const frontendOverlay = runtime.frontend?.overlayPayload ? path.join(root, runtime.frontend.overlayPayload) : ''
const backendDist = path.join(root, 'server/dist')
const lvzaiLoginScript = path.join(root, 'server/scripts/lvzai-login.py')
const wecomLedgerExtractor = path.join(root, 'server/scripts/wecom-ledger-extractor.py')
const qxmEvidenceExtractor = path.join(root, 'server/scripts/qxm-evidence-extractor.py')
const quarantineDemoChain = path.join(root, 'server/scripts/quarantine_demo_chain.py')
const dailyReconciliationModule = path.join(root, 'server/scripts/daily_reconciliation_probe.py')
const dailyReconciliationCandidates = path.join(root, 'server/scripts/daily_reconciliation_candidates.py')
const dailyReconciliationRollback = path.join(root, 'server/scripts/rollback_r160_publication_mode.py')
const dailyReconciliationProbe = path.join(root, 'server/scripts/probe-fine-report-daily-reconciliation.py')
const dailyReconciliationPublisher = path.join(root, 'server/scripts/publish-daily-reconciliation.mjs')
const dailyReconciliationRunner = path.join(root, 'server/scripts/run-daily-reconciliation.sh')
const historicalGapRecovery = path.join(root, 'server/scripts/recover_historical_gap.py')
const aphScraper = path.join(root, 'server/scripts/scrape_and_import.py')
const dailyReconciliationService = path.join(root, 'server/systemd/cockpit-daily-reconciliation.service')
const dailyReconciliationTimer = path.join(root, 'server/systemd/cockpit-daily-reconciliation.timer')
const dailyReconciliationBackfillService = path.join(root, 'server/systemd/cockpit-daily-reconciliation-backfill.service')
const apiService = path.join(root, 'deploy/production/r127/first-service-cockpit.service')
const operationsRuntimePreflight = path.join(root, 'scripts/preflight-production-operations.sh')
const deployProductionRelease = path.join(root, 'scripts/deploy-production-release.sh')
const nginxConfig = path.join(root, 'deploy/production/r127/review-system.conf')
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const staticFrontendExtension = /\.(?:css|html?|ico|jpe?g|js|png|svg|ttf|webp|woff2?)$/i

async function hydrateFrontendDependencies(frontendRoot) {
  const htmlFiles = (await filesUnder(frontendRoot)).filter(file => file.endsWith('.html'))
  const references = new Set()
  for (const htmlFile of htmlFiles) {
    const html = await fs.readFile(htmlFile, 'utf8')
    for (const match of html.matchAll(/(?:src|href)=["'](\/[^"'#?]+)(?:[?#][^"']*)?["']/g)) {
      if (staticFrontendExtension.test(match[1])) references.add(match[1].slice(1))
    }
  }

  const overlayRoot = path.join(root, 'production-overlays')
  const overlayPayloads = (await fs.readdir(overlayRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(overlayRoot, entry.name, 'payload'))
  for (const reference of [...references].sort()) {
    if (!reference || reference.includes('\\') || path.posix.isAbsolute(reference) || path.posix.normalize(reference) !== reference) {
      throw new Error(`非法前端入口依赖路径：/${reference}`)
    }
    const target = path.join(frontendRoot, reference)
    try { if ((await fs.stat(target)).isFile()) continue } catch {}
    const sources = []
    for (const payload of overlayPayloads) {
      const candidate = path.join(payload, reference)
      try { if ((await fs.stat(candidate)).isFile()) sources.push(candidate) } catch {}
    }
    if (sources.length === 0) throw new Error(`前端入口依赖缺少本地来源：/${reference}`)
    const variants = new Map()
    for (const source of sources) {
      const contents = await fs.readFile(source)
      variants.set(sha256(contents), source)
    }
    if (variants.size !== 1) throw new Error(`前端入口依赖存在内容冲突：/${reference}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(variants.values().next().value, target)
  }
}

for (const required of [sourcePayload, frontendOverlay, path.join(backendDist, 'index.js'), path.join(backendDist, 'lvzai-sync-cli.js'), path.join(backendDist, 'lvzai-discover-cli.js'), path.join(backendDist, 'wecom-ledger-sync-cli.js'), path.join(backendDist, 'qxm-evidence-sync-cli.js'), lvzaiLoginScript, wecomLedgerExtractor, qxmEvidenceExtractor, quarantineDemoChain, dailyReconciliationModule, dailyReconciliationCandidates, dailyReconciliationRollback, dailyReconciliationProbe, dailyReconciliationPublisher, dailyReconciliationRunner, historicalGapRecovery, aphScraper, apiService, dailyReconciliationService, dailyReconciliationTimer, dailyReconciliationBackfillService, operationsRuntimePreflight, deployProductionRelease, nginxConfig].filter(Boolean)) {
  try { await fs.access(required) } catch { throw new Error(`缺少发布输入：${path.relative(root, required)}`) }
}
if (frontendOverlay) {
  const overlayFiles = (await fs.readdir(frontendOverlay, { withFileTypes: true })).filter(entry => entry.isFile())
  const htmlFiles = overlayFiles.filter(entry => entry.name.endsWith('.html'))
  if (!htmlFiles.some(entry => entry.name === 'index.html')) throw new Error('前端增量缺少 index.html')
  const htmlDocuments = await Promise.all(htmlFiles.map(entry => fs.readFile(path.join(frontendOverlay, entry.name), 'utf8')))
  const referencedByHtml = htmlDocuments.join('\n')
  for (const entry of overlayFiles.filter(entry => !entry.name.endsWith('.html'))) {
    if (!referencedByHtml.includes(`/${entry.name}`)) throw new Error(`前端增量未被HTML入口引用：${entry.name}`)
    if (entry.name.endsWith('.js')) new vm.Script(await fs.readFile(path.join(frontendOverlay, entry.name), 'utf8'), { filename: entry.name })
  }
}
await fs.rm(output, { recursive: true, force: true })
await fs.mkdir(output, { recursive: true })
await fs.cp(sourcePayload, path.join(output, 'frontend'), { recursive: true })
if (frontendOverlay) await fs.cp(frontendOverlay, path.join(output, 'frontend'), { recursive: true, force: true })
await hydrateFrontendDependencies(path.join(output, 'frontend'))
await fs.cp(backendDist, path.join(output, 'backend/dist'), { recursive: true })
await fs.mkdir(path.join(output, 'backend/operations'), { recursive: true })
await fs.copyFile(lvzaiLoginScript, path.join(output, 'backend/operations/lvzai-login.py'))
await fs.chmod(path.join(output, 'backend/operations/lvzai-login.py'), 0o750)
await fs.copyFile(wecomLedgerExtractor, path.join(output, 'backend/operations/wecom-ledger-extractor.py'))
await fs.chmod(path.join(output, 'backend/operations/wecom-ledger-extractor.py'), 0o750)
await fs.copyFile(qxmEvidenceExtractor, path.join(output, 'backend/operations/qxm-evidence-extractor.py'))
await fs.chmod(path.join(output, 'backend/operations/qxm-evidence-extractor.py'), 0o750)
await fs.copyFile(quarantineDemoChain, path.join(output, 'backend/operations/quarantine_demo_chain.py'))
await fs.chmod(path.join(output, 'backend/operations/quarantine_demo_chain.py'), 0o750)
for (const operation of [dailyReconciliationModule, dailyReconciliationCandidates, dailyReconciliationRollback, dailyReconciliationProbe, dailyReconciliationPublisher, dailyReconciliationRunner, historicalGapRecovery, aphScraper]) {
  const target=path.join(output,'backend/operations',path.basename(operation))
  await fs.copyFile(operation,target)
  await fs.chmod(target,0o750)
}
await fs.mkdir(path.join(output, 'backend/systemd'), { recursive: true })
await fs.copyFile(apiService, path.join(output, 'backend/systemd/first-service-cockpit.service'))
await fs.chmod(path.join(output, 'backend/systemd/first-service-cockpit.service'), 0o644)
for (const unit of [dailyReconciliationService, dailyReconciliationTimer, dailyReconciliationBackfillService]) {
  const target = path.join(output, 'backend/systemd', path.basename(unit))
  await fs.copyFile(unit, target)
  await fs.chmod(target, 0o644)
}
await fs.mkdir(path.join(output, 'deploy'), { recursive: true })
await fs.copyFile(nginxConfig, path.join(output, 'deploy/review-system.conf'))
await fs.copyFile(operationsRuntimePreflight, path.join(output, 'deploy/operations-runtime-preflight.sh'))
await fs.chmod(path.join(output, 'deploy/operations-runtime-preflight.sh'), 0o750)
await fs.copyFile(deployProductionRelease, path.join(output, 'deploy/deploy-production-release.sh'))
await fs.chmod(path.join(output, 'deploy/deploy-production-release.sh'), 0o750)

async function filesUnder(directory) {
  const rows = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) rows.push(...await filesUnder(target))
    else if (entry.isFile()) rows.push(target)
  }
  return rows
}
const files = []
for (const file of await filesUnder(output)) {
  const contents = await fs.readFile(file)
  files.push({ path: path.relative(output, file), bytes: contents.length, sha256: sha256(contents) })
}
files.sort((a, b) => a.path.localeCompare(b.path))
const sourceFiles = [
  ...await filesUnder(path.join(root, 'server/src')),
  lvzaiLoginScript,
  wecomLedgerExtractor,
  qxmEvidenceExtractor,
  quarantineDemoChain,
  dailyReconciliationModule,
  dailyReconciliationCandidates,
  dailyReconciliationRollback,
  dailyReconciliationProbe,
  dailyReconciliationPublisher,
  dailyReconciliationRunner,
  historicalGapRecovery,
  aphScraper,
  dailyReconciliationService,
  dailyReconciliationTimer,
  dailyReconciliationBackfillService,
  apiService,
  operationsRuntimePreflight,
  deployProductionRelease,
  path.join(root, 'server/scripts/sync-lvzai-arrears.ts'),
  path.join(root, 'server/scripts/discover-lvzai-arrears-scope.ts'),
  path.join(root, 'server/scripts/sync-wecom-ledger.ts'),
  path.join(root, 'server/scripts/sync-qxm-evidence.ts'),
].sort()
const sourceHash = crypto.createHash('sha256')
for (const file of sourceFiles) {
  sourceHash.update(path.relative(path.join(root, 'server'), file)).update('\0').update(await fs.readFile(file)).update('\0')
}
const sourceTreeSha256 = sourceHash.digest('hex')
const requestedRelease = String(arg('--release') || '').trim()
const release = requestedRelease || `cockpit-candidate-${sourceTreeSha256.slice(0, 12)}`
if (!/^cockpit-[a-z0-9][a-z0-9._-]{4,100}$/.test(release)) throw new Error('候选发布标识非法')
const manifest = {
  schemaVersion: 1,
  release,
  createdAt: new Date().toISOString(),
  expectedProduction: {
    indexSha256: expectedProductionIndexSha256,
    backendDistIndexSha256: runtime.backend.distIndexSha256,
  },
  deployer: { protocol: 2, path: 'deploy/deploy-production-release.sh', sha256: sha256(await fs.readFile(deployProductionRelease)) },
  source: { node: '20', commit: sourceCommit, packageLockSha256: sha256(await fs.readFile(path.join(root, 'server/package-lock.json'))), treeSha256: sourceTreeSha256 },
  health: { local: 'http://127.0.0.1:3002/api/health/ready', public: `${baseline.origin}/api/health/ready` },
  files,
}
await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({ release: manifest.release, output: path.relative(root, output), files: files.length, sourceTreeSha256: manifest.source.treeSha256 }, null, 2))
