import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8')

const projects = read('src/routes/projects.ts')
const projectDirectory = read('src/project-directory.ts')
const trends = read('src/routes/trends.ts')
const governance = read('src/routes/governance.ts')
const ai = read('src/routes/ai.ts')
const exportsRoute = read('src/routes/export.ts')
const gate = read('src/data-quality-gate.ts')

test('三个正式动作只使用最终路由与确认词', () => {
  assert.match(projects, /router\.post\('\/api\/projects\/directory\/publish'/)
  assert.match(projects, /确认发布项目目录/)
  assert.match(trends, /router\.post\('\/api\/trends\/rebuild'/)
  assert.match(trends, /确认重建月度趋势/)
  assert.match(governance, /router\.post\('\/api\/governance\/report-archives\/generate'/)
  assert.match(governance, /确认生成正式归档/)
  assert.doesNotMatch([projects, trends, governance].join('\n'), /projects\/directory\/publish-confirmed|trends\/rebuild-confirmed|report-archives\/generate-confirmed/)
})

test('趋势与归档列表返回 rows 和显式状态', () => {
  assert.match(trends, /router\.get\('\/api\/trends'[\s\S]*?res\.json\(\{\s*rows,[\s\S]*?status/)
  assert.match(governance, /router\.get\('\/api\/governance\/report-archives'[\s\S]*?res\.json\(\{\s*rows,[\s\S]*?status/)
})

test('directory_only 保留目录与正式收缴事实，未知经营字段保持 null', () => {
  assert.match(projectDirectory, /DIRECTORY_VALIDATION_STATUS = 'directory_only'/)
  for (const field of ['annual_income', 'annual_cost', 'ytd_income', 'ytd_cost', 'quality_score', 'customer_satisfaction']) {
    assert.match(projectDirectory, new RegExp(field))
    assert.doesNotMatch(projectDirectory, new RegExp(`${field}\\s*\\|\\|\\s*0`))
  }
  assert.match(projectDirectory, /collectionFactsByProfile/)
  assert.match(projectDirectory, /data_ingestion_rows[\s\S]*?collection_center/)
  assert.match(projectDirectory, /receivable[\s\S]*?received[\s\S]*?officialRate/)
  assert.match(projects, /if \(!availability\.operatingFactsAvailable\)[\s\S]*?profitRate: null/)
  assert.match(projects, /dataAvailable: false[\s\S]*?healthScore: null/)
})

test('AI与项目CSV共用经营真实性门禁，directory_only不得替代项目经营事实', () => {
  const activeProjectCsv = exportsRoute.slice(
    exportsRoute.indexOf("router.get('/api/export/projects-csv'"),
    exportsRoute.indexOf("router.use(['/api/export/report'"),
  )
  assert.match(gate, /directory_only/)
  assert.match(gate, /ready/)
  assert.match(ai, /PROJECT_DATA_QUALITY_BLOCKED/)
  assert.match(ai, /const gate = readProjectDataGate\(db\)[\s\S]*?if \(!gate\.ready\)[\s\S]*?res\.status\(409\)/)
  assert.match(exportsRoute, /if \(!operatingGate\.ready\) return res\.status\(409\)\.json\(projectDataBlockedPayload\(db\)\)/)
  assert.doesNotMatch(exportsRoute, /readProjectDirectoryStatus|directoryStatus/)
  assert.doesNotMatch(activeProjectCsv, /!operatingGate\.ready\s*&&/)
})
