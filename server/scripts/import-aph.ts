/**
 * 从 APH 决策系统 JSON 导入华北回款额汇总数据到 cockpit.db
 * 数据源: 绿仔数据/APH决策_每日提取_*.json
 * 用法: npx tsx scripts/import-aph.ts
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'cockpit.db')

// 找最新的 APH 提取文件
const dataDir = path.join(__dirname, '..', '..', '..', '绿仔数据')
const files = fs.readdirSync(dataDir).filter(f => f.startsWith('APH决策_每日提取_') && f.endsWith('.json'))
if (files.length === 0) {
  console.error('未找到 APH决策_每日提取_*.json')
  process.exit(1)
}
const latest = files.sort().reverse()[0]
const dataPath = path.join(dataDir, latest)
console.log(`📂 读取: ${latest}`)

const raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
const aph = raw['华北地区']['回款额']

const ANNUAL_BUDGET = aph['年度预算_万']     // 25,069
const CUMULATIVE_BUDGET = aph['累计预算_万']   // 11,789
const CUMULATIVE_EXECUTED = aph['累计执行_万']  // 8,574
const ANNUAL_RATE = aph['年度完成率'] / 100     // 0.34
const CUMULATIVE_RATE = aph['累计完成率'] / 100  // 0.73

console.log('📊 APH 华北回款额:')
console.log(`   年度预算: ${ANNUAL_BUDGET}万`)
console.log(`   累计预算: ${CUMULATIVE_BUDGET}万`)
console.log(`   累计执行: ${CUMULATIVE_EXECUTED}万`)
console.log(`   年度完成率: ${(ANNUAL_RATE * 100).toFixed(1)}%`)
console.log(`   累计完成率: ${(CUMULATIVE_RATE * 100).toFixed(1)}%`)

// ─── 更新每个服务中心的累计预算/执行，使总和匹配 APH 数据 ──
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

// 获取当前服务中心列表及年预算
const centers = db.prepare(
  'SELECT id, annual_budget, cumulative_executed FROM payment_centers'
).all() as { id: number; annual_budget: number; cumulative_executed: number }[]

const totalAnnual = centers.reduce((s, c) => s + c.annual_budget, 0)

// 按各中心年预算占比，分配 APH 所有指标
const budgetRatio = CUMULATIVE_BUDGET / totalAnnual
const execRatio = CUMULATIVE_EXECUTED / totalAnnual
const sameRatio = (aph['同期执行_万'] || 9409) / totalAnnual
const annualRatio = ANNUAL_BUDGET / totalAnnual

const update = db.prepare(`
  UPDATE payment_centers SET
    annual_budget = ROUND(annual_budget * ?),
    cumulative_budget = ROUND(annual_budget * ?),
    cumulative_executed = ROUND(annual_budget * ?),
    same_period = ROUND(annual_budget * ?)
  WHERE id = ?
`)

const batch = db.transaction(() => {
  for (const c of centers) {
    update.run(annualRatio, budgetRatio, execRatio, sameRatio, c.id)
  }
})
batch()

db.close()

// ─── 验证 ─────────────────────────────────────────────
const verify = new Database(DB_PATH)
const row = verify.prepare(`
  SELECT
    SUM(cumulative_budget) as cb,
    SUM(cumulative_executed) as ce,
    SUM(same_period) as sp
  FROM payment_centers
`).get() as any

console.log(`\n💾 cockpit.db 已更新:`)
console.log(`   累计预算: ${row.cb}万 (目标 ${CUMULATIVE_BUDGET}万)`)
console.log(`   累计执行: ${row.ce}万 (目标 ${CUMULATIVE_EXECUTED}万)`)
console.log(`   同期执行: ${row.sp}万`)
verify.close()

// ─── 更新静态 fallback ────────────────────────────────
const staticPath = path.join(__dirname, '..', '..', 'src', 'data', 'cockpit-data.ts')
let staticContent = fs.readFileSync(staticPath, 'utf-8')

staticContent = staticContent.replace(
  /annualBudget: \d+/,
  `annualBudget: ${ANNUAL_BUDGET}`
)
staticContent = staticContent.replace(
  /cumulativeBudget: \d+/,
  `cumulativeBudget: ${CUMULATIVE_BUDGET}`
)
staticContent = staticContent.replace(
  /cumulativeExecuted: \d+/,
  `cumulativeExecuted: ${CUMULATIVE_EXECUTED}`
)
staticContent = staticContent.replace(
  /annualRate: [\d.]+/,
  `annualRate: ${ANNUAL_RATE}`
)
staticContent = staticContent.replace(
  /cumulativeRate: [\d.]+/,
  `cumulativeRate: ${CUMULATIVE_RATE}`
)

fs.writeFileSync(staticPath, staticContent)
console.log('\n📝 static fallback 已同步')

console.log('\n🎉 导入完成！重启后端即可。')
