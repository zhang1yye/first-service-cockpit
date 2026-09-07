import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildHeadBundle } from './build-frontend-bundles.mjs'

const root = path.resolve(import.meta.dirname, '..')
const release = 'cockpit-r90-operating-capabilities-20260816-204727'
const baselineRelease = 'cockpit-r89-ai-opinion-20260816-194449'
const baselineDir = path.join(root, 'release-candidates', baselineRelease)
const candidate = path.join(root, 'release-candidates', release)
const payload = path.join(candidate, 'payload')
const source = path.join(candidate, 'source')
const serverDist = path.join(candidate, 'server-dist')
const serverSource = path.join(candidate, 'server-src')
const backendSourceFiles = [
  'src/index.ts',
  'src/operating-capabilities.ts',
  'src/routes/operating-capabilities.ts',
  'src/data-quality-gate.ts',
  'src/project-directory.ts',
  'src/report-archive-generator.ts',
  'src/data-source-copy.ts',
  'src/admin-quality.ts',
  'src/routes/project-profiles.ts',
]

const refs = {
  script: '/aph2-r90-operating-capabilities-20260816-v1.js?v=r90-capabilities1',
  stylesheet: '/aph2-r90-operating-capabilities-20260816-v1.css?v=r90-capabilities1',
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function insertOnce(value, marker, addition, label) {
  const first = value.indexOf(marker)
  if (first < 0 || value.indexOf(marker, first + marker.length) >= 0) throw new Error(`${label}边界不是唯一匹配`)
  return `${value.slice(0, first)}${addition}${value.slice(first)}`
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory)
  const files = []
  for (const entry of entries.sort()) {
    const absolute = path.join(directory, entry)
    const relative = path.join(prefix, entry)
    const info = await stat(absolute)
    if (info.isDirectory()) files.push(...await listFiles(absolute, relative))
    else files.push(relative)
  }
  return files
}

const productionBaseline = JSON.parse(await readFile(path.join(root, 'config', 'production-baseline.json'), 'utf8'))
const baselineManifest = JSON.parse(await readFile(path.join(baselineDir, 'manifest.json'), 'utf8'))
const baselineIndex = await readFile(path.join(baselineDir, 'payload', 'index.expected.html'), 'utf8')
if (baselineManifest.release !== baselineRelease) throw new Error('R89候选标识不匹配')
if (sha256(baselineIndex) !== productionBaseline.indexSha256) throw new Error('R89候选入口已偏离当前生产基线')

const frontendJsPath = path.join(root, 'firstcare-cloud-local', 'aph2-r90-operating-capabilities-20260816-v1.js')
const frontendCssPath = path.join(root, 'firstcare-cloud-local', 'aph2-r90-operating-capabilities-20260816-v1.css')
const [frontendJs, frontendCss] = await Promise.all([
  readFile(frontendJsPath),
  readFile(frontendCssPath),
])

let nextIndex = insertOnce(
  baselineIndex,
  '</head>',
  `  <link rel="stylesheet" href="${refs.stylesheet}">\n`,
  'head',
)
nextIndex = insertOnce(
  nextIndex,
  '</body>',
  `    <script src="${refs.script}" defer></script>\n`,
  'body',
)

await mkdir(candidate, { recursive: false })
await mkdir(payload, { recursive: false })
await mkdir(source, { recursive: false })
await mkdir(serverSource, { recursive: false })
await mkdir(path.join(payload, 'assets'), { recursive: false })
await cp(path.join(root, 'server', 'dist'), serverDist, { recursive: true, errorOnExist: true })
for (const relative of backendSourceFiles) {
  const target = path.join(serverSource, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await cp(path.join(root, 'server', relative), target, { errorOnExist: true })
}
await cp(path.join(baselineDir, 'payload', 'assets'), path.join(payload, 'assets'), { recursive: true, errorOnExist: false })
await cp(path.join(root, 'firstcare-cloud-local', 'assets'), path.join(payload, 'assets'), {
  recursive: true,
  errorOnExist: false,
})
await cp(path.join(root, 'firstcare-cloud-local', 'aph-icons'), path.join(payload, 'aph-icons'), {
  recursive: true,
  errorOnExist: true,
})

const head = buildHeadBundle()
if (!head.ok) throw new Error('head bundle未通过生产哈希校验')
const directFiles = {
  'payload/index.expected.html': Buffer.from(nextIndex),
  'payload/favicon.svg': await readFile(path.join(root, 'firstcare-cloud-local', 'favicon.svg')),
  'payload/logo.png': await readFile(path.join(root, 'firstcare-cloud-local', 'logo.png')),
  'payload/aph2-r80-current-site-fixes-20260816-v1.js': await readFile(path.join(root, 'firstcare-cloud-local', 'aph2-r80-current-site-fixes-20260816-v1.js')),
  'payload/aph2-r80-current-site-fixes-20260816-v1.css': await readFile(path.join(root, 'firstcare-cloud-local', 'aph2-r80-current-site-fixes-20260816-v1.css')),
  'payload/aph2-r77-app-bootstrap-20260813-v1.js': await readFile(path.join(root, 'firstcare-cloud-local', 'aph2-r77-app-bootstrap-20260813-v1.js')),
  'payload/aph2-r56-ai-service-centers-20260812-v1.css': await readFile(path.join(root, 'firstcare-cloud-local', 'aph2-r56-ai-service-centers-20260812-v1.css')),
  'payload/assets/cockpit-bundle-head-20260816.js': Buffer.from(head.output),
  'payload/aph2-r90-operating-capabilities-20260816-v1.js': frontendJs,
  'payload/aph2-r90-operating-capabilities-20260816-v1.css': frontendCss,
  'source/aph2-r90-operating-capabilities-20260816-v1.js': frontendJs,
  'source/aph2-r90-operating-capabilities-20260816-v1.css': frontendCss,
}
for (const [relative, contents] of Object.entries(directFiles)) {
  await writeFile(path.join(candidate, relative), contents)
}

const outputFiles = {}
for (const relative of [
  ...await listFiles(payload, 'payload'),
  ...await listFiles(source, 'source'),
  ...await listFiles(serverDist, 'server-dist'),
  ...await listFiles(serverSource, 'server-src'),
]) {
  outputFiles[relative] = await readFile(path.join(candidate, relative))
}

const manifest = {
  release,
  createdAt: new Date().toISOString(),
  productionMutationPerformed: false,
  baseline: {
    release: baselineRelease,
    indexSha256: productionBaseline.indexSha256,
  },
  refs,
  protectedRoutes: ['/daily', '/payment', '/collection'],
  businessScope: {
    sources: ['APH回款', '绿仔正式收缴'],
    projectDirectoryOnly: true,
    projectOperatingMetrics: 'not-connected',
  },
  backendSourceFiles,
  files: Object.entries(outputFiles).map(([relative, contents]) => ({
    path: relative,
    size: contents.length,
    sha256: sha256(contents),
  })),
}
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
await writeFile(path.join(candidate, 'manifest.json'), manifestText)
const sums = [
  ...manifest.files,
  { path: 'manifest.json', sha256: sha256(manifestText) },
].map(file => `${file.sha256}  ${file.path}`).join('\n')
await writeFile(path.join(candidate, 'SHA256SUMS'), `${sums}\n`)

console.log(JSON.stringify({
  release,
  candidate,
  baselineIndexSha256: productionBaseline.indexSha256,
  candidateIndexSha256: sha256(nextIndex),
  frontendJsSha256: sha256(frontendJs),
  frontendCssSha256: sha256(frontendCss),
  fileCount: manifest.files.length,
  productionMutationPerformed: false,
}, null, 2))
