import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OLD_SCRIPT = '/aph2-r90-operating-capabilities-20260816-v1.js?v=r90-capabilities1'
const OLD_STYLESHEET = '/aph2-r90-operating-capabilities-20260816-v1.css?v=r90-capabilities1'
const NEW_SCRIPT = '/aph2-r91-frontend-data-state-20260817-v1.js?v=r91-data-state1'
const NEW_STYLESHEET = '/aph2-r91-frontend-data-state-20260817-v1.css?v=r91-data-state1'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function replaceExactlyOnce(value, oldValue, newValue, label) {
  const first = value.indexOf(oldValue)
  if (first < 0 || value.indexOf(oldValue, first + oldValue.length) >= 0) {
    throw new Error(`${label}不是唯一R90基线引用`)
  }
  return `${value.slice(0, first)}${newValue}${value.slice(first + oldValue.length)}`
}

export function buildCandidateIndex(baselineIndex) {
  let candidate = replaceExactlyOnce(String(baselineIndex), OLD_STYLESHEET, NEW_STYLESHEET, '样式')
  candidate = replaceExactlyOnce(candidate, OLD_SCRIPT, NEW_SCRIPT, '脚本')
  return candidate
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

function main() {
  const baselinePath = argument('--baseline-index')
  const outputDirectory = argument('--output-dir')
  if (!baselinePath || !outputDirectory) {
    throw new Error('必须提供 --baseline-index <当前生产入口> 与 --output-dir <候选目录>')
  }

  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'config/production-baseline.json'), 'utf8'))
  const baselineIndex = fs.readFileSync(path.resolve(baselinePath))
  const baselineHash = sha256(baselineIndex)
  if (baselineHash !== baseline.indexSha256) throw new Error('输入入口与R90生产基线哈希不一致')

  const jsPath = path.join(root, 'firstcare-cloud-local/aph2-r91-frontend-data-state-20260817-v1.js')
  const cssPath = path.join(root, 'firstcare-cloud-local/aph2-r91-frontend-data-state-20260817-v1.css')
  const js = fs.readFileSync(jsPath)
  const css = fs.readFileSync(cssPath)
  const nextIndex = Buffer.from(buildCandidateIndex(baselineIndex.toString('utf8')))
  const output = path.resolve(outputDirectory)
  fs.mkdirSync(output, { recursive: false })
  fs.writeFileSync(path.join(output, 'index.expected.html'), nextIndex)
  fs.writeFileSync(path.join(output, path.basename(jsPath)), js)
  fs.writeFileSync(path.join(output, path.basename(cssPath)), css)

  const manifest = {
    release: 'cockpit-r91-frontend-data-state-20260817-v1',
    createdAt: new Date().toISOString(),
    productionMutationPerformed: false,
    baseline: { release: baseline.release, indexSha256: baseline.indexSha256 },
    replaces: { script: OLD_SCRIPT, stylesheet: OLD_STYLESHEET },
    refs: { script: NEW_SCRIPT, stylesheet: NEW_STYLESHEET },
    protectedRoutes: ['/daily', '/payment', '/collection'],
    files: [
      { path: 'index.expected.html', bytes: nextIndex.length, sha256: sha256(nextIndex) },
      { path: path.basename(jsPath), bytes: js.length, sha256: sha256(js) },
      { path: path.basename(cssPath), bytes: css.length, sha256: sha256(css) },
    ],
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ output, ...manifest }, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
