import express from 'express'
import cors from 'cors'
import summaryRouter from './routes/summary.js'
import paymentsRouter from './routes/payments.js'
import collectionsRouter from './routes/collections.js'
import trendsRouter from './routes/trends.js'
import authRouter from './routes/auth.js'
import usersRouter from './routes/users.js'
import dailyRouter from './routes/daily.js'
import projectsRouter from './routes/projects.js'
import projectProfilesRouter from './routes/project-profiles.js'
import projectOperatingImportRouter from './routes/project-operating-import.js'
import serviceCenterMasterRouter from './routes/service-center-master.js'
import operatingCapabilitiesRouter from './routes/operating-capabilities.js'
import importRouter from './routes/import.js'
import aiRouter from './routes/ai.js'
import regionalAssistantRouter from './routes/regional-assistant.js'
import arrearsAnalysisRouter from './routes/arrears-analysis.js'
import fiveBooksRouter from './routes/five-books.js'
import exportRouter from './routes/export.js'

import governanceRouter from './routes/governance.js'
import dataSourcesRouter from './routes/data-sources.js'
import integrationsRouter from './routes/integrations.js'
import healthRouter from './routes/health.js'
import weeklyMeetingsRouter from './routes/weekly-meetings.js'
import forecastsRouter from './routes/forecasts.js'

import formalOutputsRouter from './routes/formal-outputs.js'
import dataPipelineRouter from './routes/data-pipeline.js'
import adminRouter from './routes/admin.js'
import { isDailyReconciliationAutomationPath, requireAuth, requireAdmin } from './auth.js'
import { startArrearsRetentionJob } from './arrears-retention.js'
import { denyScopedAccess } from './auth.js'

const app = express()
const PORT = process.env.PORT || 3001
const HOST = process.env.HOST || '127.0.0.1'

// 只信任同机反向代理；req.ip据此取最靠近应用的未受信地址，忽略客户端伪造的X-Forwarded-For前缀。
app.set('trust proxy', 'loopback')

// CORS
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['http://localhost:5173', 'http://localhost:4173']

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}))
app.use(express.json())

// 公开路由（无需登录）
app.use(authRouter)
app.use(integrationsRouter)
app.use(healthRouter)

// 数据路由（需要登录；requireAuth仅对两个专项日报POST识别目的受限自动化JWT）
app.use(requireAuth)

// 成员只有查询自己服务中心的权限；所有会修改业务状态的请求统一在路由前拦截。
// AI问数虽然使用POST，但属于只读查询，不写经营数据，保留给成员使用。
app.use((req: any, res, next) => {
  const readOnlyPost = req.method === 'POST' && [
    '/api/ai/ask',
    '/api/ai/assistant/ask',
    '/api/ai/interpret',
    '/api/ai/service-centers/analysis-runs',
  ].includes(req.path)
  // 仅保留本人改密这一项自助安全写；路由会校验旧密码/新密码策略、严格审计并
  // 递增token_version。当前authRouter在本中间件之前注册，此例外也用于防止未来
  // 调整路由顺序时误伤顶部“密码修改”。
  const selfServicePassword = req.method === 'PUT' && req.path === '/api/auth/password'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !readOnlyPost && !selfServicePassword
      && !isDailyReconciliationAutomationPath(req) && req.user?.role !== 'admin') {
    return denyScopedAccess(req, res, '普通成员仅可查看本人服务中心数据')
  }
  next()
})
// 全局真实性门禁错误含全地区项目计数；成员只能接收通用状态，避免聚合侧信道。
app.use((req: any, res, next) => {
  if (req.user?.role === 'admin') return next()
  const json = res.json.bind(res)
  res.json = (body: any) => {
    if (body?.code === 'PROJECT_DATA_QUALITY_BLOCKED') {
      return json({
        error: '当前服务中心的项目经营数据尚未通过真实性门禁',
        code: 'PROJECT_DATA_QUALITY_BLOCKED',
        dataQuality: { ready: false, status: 'blocked', scoped: true },
      })
    }
    return json(body)
  }
  next()
})
app.use(summaryRouter)
app.use(paymentsRouter)
app.use(dailyRouter)

// 任务模块已按经营产品范围正式下线。历史表只读封存，不再暴露任务API或任何自动建任务入口。
app.use((req, res, next) => {
  const removed = req.path.startsWith('/api/tasks')
    || req.path.startsWith('/api/remediation-impact')
    || req.path === '/api/data-sources/auto-jobs/repair-tasks'
    || req.path === '/api/data-sources/master-data/migrate-legacy-tasks'
    || /^\/api\/weekly-meetings\/\d+\/items\/\d+\/create-task$/.test(req.path)
  if (removed) return res.status(410).json({ error: '任务模块已下线，历史记录仅作只读封存。', moduleRemoved: true })
  next()
})

// 权限按路径前缀收口，避免无路径 requireAdmin 拦截后续 manager 路由
function guard(prefixes: string[], middleware: any) {
  return (req: any, res: any, next: any) => {
    if (isDailyReconciliationAutomationPath(req)) return next()
    return prefixes.some(p => req.path.startsWith(p)) ? middleware(req, res, next) : next()
  }
}
app.use(guard([
  '/api/admin', '/api/import', '/api/data-pipeline', '/api/users', '/api/governance',
  '/api/project-operating-import', '/api/service-center-master',
  '/api/data-sources', '/api/formal-outputs', '/api/command',
], requireAdmin))

app.use(collectionsRouter)
app.use(trendsRouter)
app.use(projectsRouter)
app.use(projectProfilesRouter)
app.use(projectOperatingImportRouter)
app.use(serviceCenterMasterRouter)
app.use(operatingCapabilitiesRouter)
app.use(importRouter)
app.use(aiRouter)
app.use(regionalAssistantRouter)
app.use(arrearsAnalysisRouter)
app.use(fiveBooksRouter)

app.use(exportRouter)
app.use(governanceRouter)
app.use(dataSourcesRouter)
app.use(weeklyMeetingsRouter)
app.use(forecastsRouter)

app.use(formalOutputsRouter)
app.use(dataPipelineRouter)
app.use(usersRouter)
app.use(adminRouter)

app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('[server] unhandled error:', err?.message || err)
  res.status(500).json({ error: '服务器内部错误' })
})

startArrearsRetentionJob()
const onListen = () => {
  console.log(`[server] 后端已启动 → http://${HOST || 'localhost'}:${PORT}`)
  console.log(`[server] CORS origins: ${allowedOrigins.join(', ')}`)
}
app.listen(Number(PORT), HOST, onListen)
