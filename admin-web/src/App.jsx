import React, { useEffect, useMemo, useState } from 'react'
import {
  compactSyncRuns,
  dateTime,
  freshnessMeta,
  formatValue,
  issueTone,
  nextWorkflowAction,
  publicationStatusLabel,
  qualityTimingTone,
  reconciliationLabel,
  roleLabel,
  safeJson,
  sourceFreshnessLabel,
  workflowLabel,
} from './lib/admin-model.mjs'

const NAV = [
  ['overview', '/aph-icons/RectangleCopy.png', '管理总览', '系统与数据全景'],
  ['quality', '/aph-icons/chengbentongjifenxi.png', '真实性中心', '异常、勾稽与伪0'],
  ['sources', '/aph-icons/caiwu.png', '数据源与同步', 'APH、绿仔、主数据'],
  ['mappings', '/aph-icons/shangye.png', '项目映射', '关联、碰撞与缺失'],
  ['rules', '/aph-icons/tiyukebu.png', '规则与口径', '阈值、目标与版本'],
  ['users', '/aph-icons/jurassic_users.png', '用户与权限', '角色和数据范围'],
  ['audit', '/aph-icons/renliziyuan.png', '操作审计', '高风险行为追踪'],
  ['recovery', '/aph-icons/fangchanwuye.png', '灾备与恢复', '备份、校验与回滚'],
  ['archives', '/aph-icons/jiaoyu.png', '归档与输出', '月报和正式成果'],
]

function getToken() {
  return localStorage.getItem('cockpit_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || ''
}
function saveToken(token, user) {
  localStorage.setItem('cockpit_token', token)
  localStorage.setItem('cockpit_user', JSON.stringify(user || {}))
}
function clearToken() {
  for (const key of ['cockpit_token', 'authToken', 'token', 'cockpit_user']) localStorage.removeItem(key)
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}), ...(options.headers || {}) },
  })
  let payload = null
  try { payload = await response.json() } catch {}
  if (!response.ok) {
    if (response.status === 401) clearToken()
    throw new Error(payload?.error || `请求失败（${response.status}）`)
  }
  return payload
}
function useLoad(loader, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: '' })
  const reload = () => {
    setState(old => ({ ...old, loading: true, error: '' }))
    Promise.resolve().then(loader).then(data => setState({ loading: false, data, error: '' })).catch(error => setState({ loading: false, data: null, error: error.message }))
  }
  useEffect(reload, deps)
  return { ...state, reload }
}

function Login({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async e => {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(form) })
      if (result.user?.role !== 'admin') throw new Error('该后台仅允许系统管理员访问')
      saveToken(result.token, result.user); onLogin(result.user)
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  return <main className="login-shell">
    <section className="login-brand">
      <img className="login-logo" src="/aph-icons/aph-brand-lockup.jpg" alt="APH 2.0" />
      <p className="eyebrow">FIRST SERVICE · NORTH CHINA</p>
      <h1>把每一个经营数字<br/><em>变成可追溯事实</em></h1>
      <p className="login-copy">数据源、同步批次、项目映射、规则口径与操作审计，在一个可信后台闭环。</p>
      <div className="signal-line"><span/><span/><span/></div>
    </section>
    <form className="login-card" onSubmit={submit}>
      <div><p className="eyebrow cyan">ADMIN CONSOLE</p><h2>管理后台登录</h2><p className="muted">使用驾驶舱管理员账号</p></div>
      <label>用户名<input autoFocus value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="请输入用户名" autoComplete="username" /></label>
      <label>密码<input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="请输入密码" autoComplete="current-password" /></label>
      {error && <div className="alert danger">{error}</div>}
      <button className="primary wide" disabled={busy}>{busy ? '验证中…' : '进入管理后台 →'}</button>
      <p className="security-note">JWT鉴权 · 管理员权限 · 全量操作审计</p>
    </form>
  </main>
}

const toneForStatus = value => /正常|成功|健康|通过|published|fresh|ok/i.test(String(value)) ? 'success' : /异常|失败|危险|过期|blocked|danger/i.test(String(value)) ? 'danger' : 'warning'
function Badge({ children, tone }) { return <span className={`badge ${tone || toneForStatus(children)}`}>{children ?? '—'}</span> }
function Card({ title, kicker, action, children, className = '' }) { return <section className={`card ${className}`}><header className="card-head"><div>{kicker && <p className="kicker">{kicker}</p>}<h3>{title}</h3></div>{action}</header>{children}</section> }
function Metric({ label, value, hint, tone = '' }) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{value ?? '—'}</strong>{hint && <small>{hint}</small>}</div> }
function Empty({ message = '暂无数据' }) { return <div className="empty"><b>—</b><span>{message}</span></div> }
function Loading() { return <div className="loading"><i/><span>正在读取真实数据…</span></div> }
function ErrorState({ message, retry }) { return <div className="error-state"><b>数据不可用</b><span>{message}</span>{retry && <button onClick={retry}>重新加载</button>}</div> }
function Table({ columns, rows = [], empty = '暂无记录' }) {
  if (!rows.length) return <Empty message={empty}/>
  return <div className="table-wrap"><table><thead><tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id ?? row.key ?? index}>{columns.map(c => <td key={c.key} data-label={c.label}>{c.render ? c.render(row[c.key], row) : row[c.key] ?? '—'}</td>)}</tr>)}</tbody></table></div>
}
function Page({ eyebrow, title, description, action, children }) { return <><div className="page-title"><div><p className="eyebrow cyan">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</div>{children}</> }

function suggestedDueDate(severity) {
  const days = ({ critical: 1, high: 3, medium: 7, low: 10 })[severity] || 7
  const date = new Date()
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function PublicationStatusCard({ status }) {
  if (!status) return <Card title="正式发布状态" kicker="PUBLICATION STATUS"><Empty message="发布完成态不可用"/></Card>
  const label = publicationStatusLabel(status.code)
  const tone = status.code === 'complete' ? 'success' : status.code === 'failed' ? 'danger' : status.code === 'partial' ? 'warning' : 'neutral'
  return <Card title="正式发布状态" kicker="PUBLICATION STATUS" className={`publication-status ${tone}`}>
    <div className="publication-status-head"><div><Badge tone={tone}>{label}</Badge><strong>{status.businessDate ?? '—'}</strong><span>当前业务日期</span></div><p>{status.summary || '当前没有足够证据判断发布状态。'}</p></div>
    <div className="metric-grid four">
      <Metric label="业务数据日期" value={status.businessDate ?? '—'}/>
      <Metric label="正式批次日期" value={status.officialBusinessDate ?? '—'} tone={status.officialBusinessDate===status.businessDate?'success':'warning'}/>
      <Metric label="未齐来源" value={status.missingSourceKeys?.length ?? '—'} tone={status.missingSourceKeys?.length?'danger':''}/>
      <Metric label="缺失发布审计" value={status.missingAuditSourceKeys?.length ?? '—'} tone={status.missingAuditSourceKeys?.length?'warning':''}/>
    </div>
    <div className="publication-source-grid">{(status.sources || []).map(source => {
      const freshness = freshnessMeta(source.businessDate)
      return <div key={source.sourceKey}><span>{source.name || source.sourceKey}</span><b>{source.businessDate ?? '—'}</b><small><Badge tone={freshness.tone}>{freshness.label}</Badge> {source.message || '来源状态未知'} · {source.rowCount ?? '—'}行</small></div>
    })}</div>
  </Card>
}

function Overview() {
  const { data, loading, error, reload } = useLoad(async () => {
    const [overview, publication] = await Promise.all([api('/api/admin/overview'), api('/api/data-sources/publication-status')])
    return { ...overview, publication }
  }, [])
  if (loading) return <Loading/>; if (error) return <ErrorState message={error} retry={reload}/>
  return <Page eyebrow="CONTROL CENTER" title="管理总览" description="生产健康、数据真实性、权限与归档的一屏总览" action={<button onClick={reload}>刷新数据</button>}>
    <PublicationStatusCard status={data.publication}/>
    <div className="metric-grid six">
      <Metric label="真实性异常" value={data.quality?.total ?? '—'} hint={`严重 ${data.quality?.critical ?? '—'} 项`} tone="danger"/>
      <Metric label="数据源" value={data.sources?.length ?? '—'} hint="APH / 绿仔 / 主数据"/>
      <Metric label="项目档案" value={data.counts?.profiles ?? '—'} hint="当前有效批次"/>
      <Metric label="系统用户" value={data.counts?.users ?? '—'} hint={`管理员 ${data.counts?.admins ?? '—'} 人`}/>
      <Metric label="操作日志" value={data.counts?.operationLogs ?? '—'} hint="全量留痕"/>
      <Metric label="数据库备份" value={data.counts?.databaseBackups ?? '—'} hint="当前保留版本"/>
    </div>
    <div className="layout-2-1">
      <Card title="最高优先级异常" kicker="DATA TRUTH">
        <div className="issue-stack">{data.topIssues?.map(issue => <article className={`issue ${issueTone(issue.severity)}`} key={issue.code}><div><Badge tone={issueTone(issue.severity)}>{issue.severity.toUpperCase()}</Badge><h4>{issue.title}</h4><p>{issue.detail}</p></div><code>{issue.code}</code></article>)}</div>
      </Card>
      <Card title="数据源状态" kicker="SOURCE HEALTH">
        <div className="source-list">{data.sources?.map(source => <div className="source-row" key={source.source_key}><i className={toneForStatus(source.status)}/><div><b>{source.name}</b><span>{dateTime(source.last_sync_at)}</span></div><Badge>{source.status}</Badge></div>)}</div>
      </Card>
    </div>
    <Card title="最近同步运行" kicker="SYNC RUNS"><Table columns={[{key:'source_name',label:'数据源'},{key:'run_type',label:'运行类型'},{key:'status',label:'状态',render:v=><Badge>{v}</Badge>},{key:'message',label:'结果'},{key:'repeat_count',label:'重复',render:v=>v>1?<Badge tone="warning">×{v}</Badge>:'—'},{key:'duration_ms',label:'耗时',render:v=>v==null?'—':`${v}ms`},{key:'finished_at',label:'完成时间',render:dateTime}]} rows={compactSyncRuns(data.latestRuns || [])}/></Card>
  </Page>
}

function Quality() {
  const { data, loading, error, reload } = useLoad(async () => {
    const report = await api('/api/admin/quality')
    const cases = await api('/api/admin/quality-cases')
    return { ...report, caseSummary: cases.summary }
  }, [])
  const [filter, setFilter] = useState('all')
  const [busyCode, setBusyCode] = useState('')
  const advance = async issue => {
    const action = nextWorkflowAction(issue.workflow?.workflow_status || 'pending')
    if (!action) return
    let owner = issue.workflow?.owner || ''
    let dueDate = ''
    let note = ''
    let evidenceRef = ''
    if (action.status === 'claimed') {
      owner = prompt('请输入该异常的负责人：', owner) || ''
      if (!owner.trim()) return
      dueDate = prompt('请输入截止日期（YYYY-MM-DD）：', issue.workflow?.due_date || suggestedDueDate(issue.severity)) || ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return alert('截止日期格式必须为YYYY-MM-DD')
    }
    if (action.status === 'review') {
      note = prompt('请填写处理说明：', issue.workflow?.handling_note || '') || ''
      if (!note.trim()) return
      evidenceRef = prompt('请填写证据位置（批次、文件SHA、链接或归档编号）：', issue.workflow?.evidence_ref || '') || ''
      if (!evidenceRef.trim()) return
    }
    if (action.status === 'resolved') {
      note = prompt('请填写复核结论与解决说明：', issue.workflow?.review_note || '') || ''
      if (!note.trim()) return
    }
    setBusyCode(issue.code)
    try {
      await api(`/api/admin/quality-cases/${encodeURIComponent(issue.code)}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: action.status, owner, dueDate, note, evidenceRef }),
      })
      reload()
    } catch (err) { alert(err.message) } finally { setBusyCode('') }
  }
  if (loading) return <Loading/>; if (error) return <ErrorState message={error} retry={reload}/>
  const issues = (data.issues || []).filter(item => filter === 'all' || item.severity === filter)
  const aph = data.sources?.aph || {}
  const layers = aph.sourceLayers || {}
  const reconciliations = Object.keys(aph.reconciliations || {}).length ? aph.reconciliations : (data.latestP46?.analysis?.reconciliations || {})
  return <Page eyebrow="DATA TRUTH" title="数据真实性中心" description="不把缺失当0，不把估算当事实，不把演示数据带入经营结论" action={<button onClick={reload}>重新检测</button>}>
    <div className="metric-grid six"><Metric label="全部异常" value={data.summary.total}/><Metric label="未闭环" value={data.caseSummary?.active ?? '—'} tone="warning"/><Metric label="待认领" value={data.caseSummary?.unassigned ?? '—'} tone={data.caseSummary?.unassigned?'danger':''}/><Metric label="已超期" value={data.caseSummary?.overdue ?? '—'} tone={data.caseSummary?.overdue?'danger':''}/><Metric label="待复核" value={data.caseSummary?.review ?? '—'} tone="info"/><Metric label="映射碰撞" value={data.collisions?.length || 0}/></div>
    <Card title="APH跨源勾稽" kicker="SOURCE RECONCILIATION">
      <div className="source-layer-grid">{[
        ['regionCard','华北地区卡片'],['budgetWeekly','预算周报'],['centerDetail','中心明细'],
      ].map(([key,label])=><div className="source-layer" key={key}><span>{label}</span><b>{formatValue(layers[key]?.values?.annualBudget,'万元')}</b><small>{layers[key]?.source || '来源不可用'} · {layers[key]?.businessDate || aph.businessDate || '—'}</small></div>)}</div>
      <Table columns={[{key:'name',label:'勾稽项'},{key:'status',label:'状态',render:v=><Badge tone={v==='matched'?'success':v==='warning'?'warning':'neutral'}>{reconciliationLabel(v)}</Badge>},{key:'left',label:'左侧来源/值'},{key:'right',label:'右侧来源/值'},{key:'difference',label:'差异',render:v=>formatValue(v,'万元')}]} rows={Object.entries(reconciliations).map(([name,row])=>({name,status:row.status,left:`${row.leftSource || '—'} / ${formatValue(row.leftValue,'万元')}`,right:`${row.rightSource || '—'} / ${formatValue(row.rightValue,'万元')}`,difference:row.difference}))} empty="暂无可用勾稽证据"/>
    </Card>
    <div className="toolbar"><div className="segmented">{['all','critical','high','medium'].map(x=><button className={filter===x?'active':''} onClick={()=>setFilter(x)} key={x}>{({all:'全部',critical:'严重',high:'高风险',medium:'中风险'})[x]}</button>)}</div><span>检测时间 {dateTime(data.generatedAt)}</span></div>
    <div className="quality-grid">{issues.map(issue => {
      const workflow = issue.workflow || { workflow_status: 'pending', owner: '' }
      const action = nextWorkflowAction(workflow.workflow_status)
      const timing = workflow.timing || {}
      return <article className={`quality-card ${issueTone(issue.severity)}`} key={issue.code}>
        <div className="quality-top"><div className="row-actions"><Badge tone={issueTone(issue.severity)}>{issue.severity}</Badge><Badge tone={workflow.workflow_status==='resolved'?'success':'info'}>{workflowLabel(workflow.workflow_status)}</Badge></div><code>{issue.code}</code></div>
        <h3>{issue.title}</h3><p>{issue.detail}</p>
        <div className="workflow-strip">
          <div className="quality-owner"><span>负责人</span><b>{workflow.owner || '待认领'}</b></div>
          <div className={`quality-timing ${qualityTimingTone(timing)}`}><span>截止日期</span><b>{workflow.due_date || '—'}</b><small>{timing.timingLabel || '待确定'}</small></div>
          <small>更新 {dateTime(workflow.updated_at)}</small>
          {action&&<button className="primary" disabled={busyCode===issue.code} onClick={()=>advance(issue)}>{busyCode===issue.code?'提交中…':action.label}</button>}
        </div>
        <dl>{Object.entries(issue.evidence || {}).slice(0,5).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{typeof v==='object'?JSON.stringify(v):String(v ?? '—')}</dd></div>)}</dl>
        {(workflow.handling_note || workflow.resolution_note)&&<div className="resolution-note"><span>处理说明</span><p>{workflow.handling_note || workflow.resolution_note}</p></div>}
        {workflow.evidence_ref&&<div className="resolution-note evidence"><span>证据位置</span><p>{workflow.evidence_ref}</p></div>}
        {workflow.review_note&&<div className="resolution-note review"><span>复核结论</span><p>{workflow.review_note}</p><small>复核人：{workflow.reviewed_by || '—'}</small></div>}
        <footer><span>处置建议</span><p>{issue.recommendation}</p></footer>
      </article>
    })}</div>
  </Page>
}

function Sources() {
  const { data, loading, error, reload } = useLoad(async () => {
    const [status, alerts, runs, jobs, quality, adminQuality, publication] = await Promise.all([
      api('/api/data-sources/status'),
      api('/api/data-sources/alerts'),
      api('/api/data-sources/sync-runs?limit=50'),
      api('/api/data-sources/auto-jobs'),
      api('/api/data-sources/quality'),
      api('/api/admin/quality'),
      api('/api/data-sources/publication-status'),
    ])
    return { status, alerts, runs, jobs, quality, adminQuality, publication }
  }, [])
  const inspect = async source => {
    if (!confirm(`立即检测“${source.name}”的数据源状态？该操作只做健康检查并记录审计，不覆盖业务数据。`)) return
    try { await api(`/api/data-sources/sync/${source.source_key || source.key}`, { method: 'POST', body: '{}' }); reload() } catch (error) { alert(error.message) }
  }
  if (loading) return <Loading/>; if (error) return <ErrorState message={error} retry={reload}/>
  const rows = data.status?.rows || data.status || []
  const sourceAlerts = Array.isArray(data.alerts?.alerts) ? data.alerts.alerts : (data.alerts?.rows || [])
  const p46 = data.adminQuality?.latestP46
  return <Page eyebrow="SOURCE CONTROL" title="数据源与同步" description="查看业务日期、文件时效、自动任务与每次同步结果" action={<button onClick={reload}>刷新状态</button>}>
    <PublicationStatusCard status={data.publication}/>
    <div className="source-cards">{rows.map(source => {
      const freshness = freshnessMeta(source.last_sync_at || source.lastSyncAt || source.businessDate || source.business_date)
      return <Card key={source.source_key || source.key} title={source.name} kicker={(source.source_key || source.key || '').toUpperCase()} action={<button onClick={()=>inspect(source)}>立即检测</button>}><div className="source-hero"><span className="source-badge-pair"><Badge>{sourceFreshnessLabel(source)}</Badge><Badge tone={freshness.tone}>{freshness.label}</Badge></span><strong>{source.businessDate || source.business_date || '—'}</strong><span>业务日期</span></div><div className="kv"><div><span>状态</span><b>{source.status || source.health || '—'}</b></div><div><span>最近同步</span><b>{dateTime(source.last_sync_at || source.lastSyncAt)}</b></div><div><span>数据量</span><b>{source.rowCount ?? source.row_count ?? '—'}</b></div><div><span>说明</span><b>{source.note || source.message || '—'}</b></div></div></Card>
    })}</div>
    <div className="layout-1-1"><Card title="自动任务" kicker="SCHEDULE"><Table columns={[{key:'name',label:'任务'},{key:'schedule',label:'计划'},{key:'status',label:'状态',render:v=><Badge>{v}</Badge>},{key:'lastRun',label:'最近运行',render:dateTime},{key:'message',label:'结果'}]} rows={data.jobs?.rows || []}/></Card><Card title="数据源告警" kicker="ALERTS"><div className="issue-stack">{sourceAlerts.length ? sourceAlerts.map((a,i)=><article className={`issue ${toneForStatus(a.level || a.health)}`} key={a.code||i}><div><Badge>{a.level || a.health}</Badge><h4>{a.title || a.name}</h4><p>{a.message || a.detail}</p></div></article>) : <Empty message="当前无数据源告警"/>}</div></Card></div>
    <Card title="最近P46证据批次" kicker="IMMUTABLE EVIDENCE">{p46?<><div className="metric-grid five"><Metric label="批次" value={`#${p46.id}`}/><Metric label="业务日期" value={p46.business_date}/><Metric label="状态" value={p46.status} tone={p46.publishable?'success':'warning'}/><Metric label="中心行数" value={p46.row_count}/><Metric label="未映射" value={p46.unmapped_count} tone={p46.unmapped_count?'danger':''}/></div><div className="evidence-sha"><span>批次 SHA-256</span><code>{p46.batch_sha256}</code></div><div className="layout-1-1"><div className="notice"><b>差异分析</b><p>新增 {p46.analysis?.diff?.added ?? '—'} · 变更 {p46.analysis?.diff?.changed ?? '—'} · 删除 {p46.analysis?.diff?.removed ?? '—'} · 未变 {p46.analysis?.diff?.unchanged ?? '—'}</p></div><div className="notice"><b>校验结论</b><p>错误 {p46.analysis?.errors?.length ?? p46.validationErrors?.length ?? 0} · 警告 {p46.analysis?.warnings?.length ?? 0} · 提取 {dateTime(p46.extracted_at)}</p></div></div><Table columns={[{key:'key',label:'源层'},{key:'name',label:'文件'},{key:'size',label:'字节数'},{key:'sha256',label:'文件SHA',render:v=><code className="clip">{v}</code>}]} rows={p46.sourceFiles||[]}/></>:<Empty message="尚无P46批次证据"/>}</Card>
    <Card title="同步运行记录" kicker="RUN HISTORY"><Table columns={[{key:'source_name',label:'数据源'},{key:'run_type',label:'类型'},{key:'status',label:'状态',render:v=><Badge>{v}</Badge>},{key:'health',label:'健康度',render:v=><Badge>{v}</Badge>},{key:'message',label:'消息'},{key:'repeat_count',label:'重复',render:v=>v>1?<Badge tone="warning">×{v}</Badge>:'—'},{key:'operator',label:'操作人'},{key:'finished_at',label:'完成时间',render:dateTime}]} rows={compactSyncRuns(data.runs?.rows || [])}/></Card>
  </Page>
}

function Mappings() {
  const { data, loading, error, reload } = useLoad(() => api('/api/admin/mappings'), [])
  const [query, setQuery] = useState('')
  if (loading) return <Loading/>; if (error) return <ErrorState message={error} retry={reload}/>
  const profiles = (data.profiles || []).filter(row => !query || `${row.service_center}${row.area}`.includes(query))
  return <Page eyebrow="MASTER DATA" title="项目映射" description="项目档案与APH、绿仔经营中心之间的唯一关联" action={<button onClick={reload}>刷新映射</button>}>
    <div className="metric-grid five"><Metric label="项目档案" value={data.summary.profiles}/><Metric label="已关联项目" value={data.summary.linkedProfiles}/><Metric label="未关联项目" value={data.summary.unlinkedProfiles} tone={data.summary.unlinkedProfiles?'warning':''}/><Metric label="关联记录" value={data.summary.links}/><Metric label="名称碰撞" value={data.summary.collisions} tone={data.summary.collisions?'danger':''}/></div>
    {data.collisions?.length>0 && <Card title="映射碰撞" kicker="COLLISION" className="danger-card"><div className="issue-stack">{data.collisions.map(c=><article className="issue danger" key={c.key}><div><Badge tone="danger">重复计算风险</Badge><h4>{c.normalizedCenter}</h4><p>同一源中心关联档案ID：{c.profileIds.join('、')}</p></div><code>{c.sourceSystem}</code></article>)}</div></Card>}
    <Card title="项目档案关联状态" kicker="PROFILE LINKS" action={<input className="search" placeholder="搜索项目或片区" value={query} onChange={e=>setQuery(e.target.value)}/>}><Table columns={[{key:'service_center',label:'服务中心'},{key:'area',label:'片区'},{key:'management_status',label:'状态',render:v=><Badge>{v}</Badge>},{key:'company_entity',label:'公司主体'},{key:'signed_area',label:'签约面积',render:v=>formatValue(v,'㎡',0)},{key:'managed_area',label:'管理面积',render:v=>formatValue(v,'㎡',0)},{key:'linkCount',label:'关联数',render:v=><Badge tone={v?'success':'warning'}>{v||'未关联'}</Badge>}]} rows={profiles}/></Card>
  </Page>
}

function Rules() {
  const { data, loading, error, reload } = useLoad(async()=>{const [rules,permissions]=await Promise.all([api('/api/governance/rules'),api('/api/governance/permissions')]);return{rules,permissions}},[])
  const [editing,setEditing]=useState(null); const [busy,setBusy]=useState(false)
  if (loading) return <Loading/>; if(error) return <ErrorState message={error} retry={reload}/>
  const save=async()=>{setBusy(true);try{await api(`/api/governance/rules/${editing.id}`,{method:'PUT',body:JSON.stringify({threshold_value:Number(editing.threshold_value),enabled:Boolean(editing.enabled)})});setEditing(null);reload()}catch(e){alert(e.message)}finally{setBusy(false)}}
  return <Page eyebrow="POLICY ENGINE" title="规则与口径" description="预警阈值、角色能力和经营口径必须有单一来源" action={<button onClick={reload}>刷新规则</button>}>
    <Card title="预警规则" kicker="ALERT RULES"><Table columns={[{key:'label',label:'规则'},{key:'rule_key',label:'编码',render:v=><code>{v}</code>},{key:'threshold_value',label:'阈值',render:(v,r)=>`${v}${r.unit||''}`},{key:'enabled',label:'状态',render:v=><Badge tone={v?'success':'neutral'}>{v?'已启用':'已停用'}</Badge>},{key:'description',label:'说明'},{key:'id',label:'操作',render:(_,r)=><button className="link" onClick={()=>setEditing({...r,enabled:Boolean(r.enabled)})}>编辑</button>}]} rows={data.rules?.rows||[]}/></Card>
    <Card title="角色权限矩阵" kicker="RBAC"><Table columns={[{key:'role',label:'角色',render:v=>roleLabel(v)},{key:'overviewRead',label:'总览',render:v=>v?'✓':'—'},{key:'operationsRead',label:'经营读取',render:v=>v?'✓':'—'},{key:'operationsWrite',label:'经营写入',render:v=>v?'✓':'—'},{key:'export',label:'导出',render:v=>v?'✓':'—'},{key:'governance',label:'治理',render:v=>v?'✓':'—'},{key:'usersManage',label:'用户管理',render:v=>v?'✓':'—'},{key:'dataScope',label:'数据范围'}]} rows={data.permissions?.rows||[]}/></Card>
    {editing&&<Modal title="编辑预警规则" onClose={()=>setEditing(null)}><label>规则名称<input value={editing.label} disabled/></label><label>阈值<input type="number" step="0.01" value={editing.threshold_value} onChange={e=>setEditing({...editing,threshold_value:e.target.value})}/></label><label className="check"><input type="checkbox" checked={editing.enabled} onChange={e=>setEditing({...editing,enabled:e.target.checked})}/>启用规则</label><div className="modal-actions"><button onClick={()=>setEditing(null)}>取消</button><button className="primary" onClick={save} disabled={busy}>保存并记录审计</button></div></Modal>}
  </Page>
}

function Modal({title,onClose,children}) { return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><section className="modal"><header><h3>{title}</h3><button onClick={onClose}>×</button></header>{children}</section></div> }

const MEMBER_TYPES = [
  ['region_manager', '地区职能'],
  ['area_manager', '片区经理'],
  ['project_manager', '项目经理'],
  ['viewer', '项目职员'],
]

function centerValues(value) {
  if (Array.isArray(value)) return value
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean)
}

function scopeDraft(row = {}) {
  return {
    ...row,
    role: row.role || 'viewer',
    area_scope: row.area_scope || '',
    service_center_scope: centerValues(row.service_center_scope),
  }
}

function ScopeFields({ value, centers, onChange, allowAdmin = false }) {
  const regionWide = value.role === 'region_manager'
  const systemWide = value.role === 'admin'
  const areas = [...new Set(centers.map(item => item.area).filter(Boolean))]
  const availableCenters = value.area_scope
    ? centers.filter(item => item.area === value.area_scope)
    : []
  const roles = allowAdmin ? [...MEMBER_TYPES, ['admin', '系统管理员']] : MEMBER_TYPES
  const changeRole = role => onChange(scopeDraft({
    ...value,
    role,
    area_scope: role === 'region_manager' || role === 'admin' ? '' : value.area_scope,
    service_center_scope: role === 'region_manager' || role === 'admin' ? [] : value.service_center_scope,
  }))
  return <>
    <label>成员类型<select value={value.role} onChange={event=>changeRole(event.target.value)}>{roles.map(([role,label])=><option value={role} key={role}>{label}</option>)}</select></label>
    {regionWide || systemWide ? <div className="alert span-2"><b>{systemWide?'系统管理员':'地区职能'}</b><p>{systemWide?'拥有系统管理权限；创建或提升管理员需要二次确认。':'自动覆盖所有片区和所有权威服务中心，但不获得系统管理写权限。'}</p></div> : <>
      <label>片区<select value={value.area_scope} onChange={event=>onChange(scopeDraft({...value,area_scope:event.target.value,service_center_scope:[]}))}><option value="">请选择片区</option>{areas.map(area=><option value={area} key={area}>{area}</option>)}</select></label>
      <label className="span-2">服务中心<select multiple value={value.service_center_scope} onChange={event=>onChange(scopeDraft({...value,service_center_scope:[...event.target.selectedOptions].map(option=>option.value)}))} disabled={!value.area_scope} aria-label="选择一个或多个服务中心">{availableCenters.map(item=><option value={item.center} key={item.center}>{item.center}</option>)}</select><small>按住 Command/Ctrl 可选择多个服务中心；未分配成员默认不能读取经营数据。</small></label>
    </>}
  </>
}

function Users() {
  const {data,loading,error,reload}=useLoad(async()=>{const [users,centers]=await Promise.all([api('/api/users'),api('/api/users/service-centers')]);return{users:Array.isArray(users)?users:users.rows||[],centers:centers.rows||[]}},[])
  const [create,setCreate]=useState(false); const [scopeEdit,setScopeEdit]=useState(null); const [form,setForm]=useState(scopeDraft({username:'',password:''})); const [busy,setBusy]=useState('')
  if(loading)return <Loading/>;if(error)return <ErrorState message={error} retry={reload}/>
  const validScope=draft=>['admin','region_manager'].includes(draft.role)||(draft.area_scope&&draft.service_center_scope.length>0)
  const submit=async()=>{if(!validScope(form))return alert('请选择片区和至少一个服务中心');setBusy('create');try{await api('/api/users',{method:'POST',body:JSON.stringify({...form,service_center_scope:form.service_center_scope,confirmation:form.role==='admin'?'确认管理员权限':undefined})});setCreate(false);setForm(scopeDraft({username:'',password:''}));reload()}catch(e){alert(e.message)}finally{setBusy('')}}
  const remove=async row=>{if(busy||prompt(`删除用户“${row.username}”将立即撤销访问权限。请输入用户名确认：`)!==row.username)return;setBusy(`delete-${row.id}`);try{await api(`/api/users/${row.id}`,{method:'DELETE',body:JSON.stringify({confirmation:row.username})});reload()}catch(e){alert(e.message)}finally{setBusy('')}}
  const reset=async row=>{if(busy)return;const password=prompt(`为“${row.username}”设置新密码（至少12位，须含字母和数字）：`);if(!password)return;setBusy(`password-${row.id}`);try{await api(`/api/users/${row.id}/password`,{method:'PUT',body:JSON.stringify({password})});alert('密码已重置，旧登录令牌已失效')}catch(e){alert(e.message)}finally{setBusy('')}}
  const saveScope=async()=>{if(!validScope(scopeEdit))return alert('请选择片区和至少一个服务中心');setBusy(`save-${scopeEdit.id}`);try{await api(`/api/users/${scopeEdit.id}/role`,{method:'PUT',body:JSON.stringify({role:scopeEdit.role,area_scope:scopeEdit.area_scope,service_center_scope:scopeEdit.service_center_scope,confirmation:scopeEdit.role==='admin'?'确认管理员权限':undefined})});setScopeEdit(null);reload()}catch(e){alert(e.message)}finally{setBusy('')}}
  return <Page eyebrow="ACCESS CONTROL" title="用户与权限" description="角色与权威服务中心范围统一治理" action={<button className="primary" disabled={Boolean(busy)} onClick={()=>setCreate(true)}>＋ 新建用户</button>}>
    <Card title="系统用户" kicker="USERS"><Table columns={[{key:'username',label:'用户名'},{key:'role',label:'角色',render:v=><Badge>{roleLabel(v)}</Badge>},{key:'area_scope',label:'片区范围',render:(v,r)=>['admin','region_manager'].includes(r.role)?'所有片区':v||'未分配'},{key:'service_center_scope',label:'服务中心',render:(v,r)=>['admin','region_manager'].includes(r.role)?'所有服务中心':v||'未分配'},{key:'created_at',label:'创建时间',render:dateTime},{key:'id',label:'操作',render:(_,r)=><div className="row-actions"><button className="link" disabled={Boolean(busy)} onClick={()=>setScopeEdit(scopeDraft(r))}>{busy===`save-${r.id}`?'保存中…':'设置'}</button><button className="link" disabled={Boolean(busy)} onClick={()=>reset(r)}>{busy===`password-${r.id}`?'修改中…':'改密'}</button><button className="link danger-text" disabled={Boolean(busy)} onClick={()=>remove(r)}>{busy===`delete-${r.id}`?'删除中…':'删除'}</button></div>}]} rows={data.users}/></Card>
    {create&&<Modal title="新建成员" onClose={()=>!busy&&setCreate(false)}><div className="form-grid"><label>用户名<input value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label><label>初始密码<input type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label><ScopeFields value={form} centers={data.centers} onChange={setForm} allowAdmin/></div><div className="modal-actions"><button disabled={Boolean(busy)} onClick={()=>setCreate(false)}>取消</button><button className="primary" disabled={Boolean(busy)||!form.username||!form.password||!validScope(form)} onClick={submit}>{busy==='create'?'创建中…':'创建成员'}</button></div></Modal>}
    {scopeEdit&&<Modal title={`设置成员 · ${scopeEdit.username}`} onClose={()=>!busy&&setScopeEdit(null)}><div className="form-grid"><ScopeFields value={scopeEdit} centers={data.centers} onChange={setScopeEdit}/></div><div className="modal-actions"><button disabled={Boolean(busy)} onClick={()=>setScopeEdit(null)}>取消</button><button className="primary" disabled={Boolean(busy)||!validScope(scopeEdit)} onClick={saveScope}>{busy===`save-${scopeEdit.id}`?'保存中…':'保存设置'}</button></div></Modal>}
  </Page>
}

function Audit() {
  const {data,loading,error,reload}=useLoad(async()=>{const [logs,summary]=await Promise.all([api('/api/governance/logs?limit=300'),api('/api/governance/audit-summary')]);return{logs,summary}},[])
  if(loading)return <Loading/>;if(error)return <ErrorState message={error} retry={reload}/>
  return <Page eyebrow="AUDIT TRAIL" title="操作审计" description="谁在什么时间对什么数据做了什么操作" action={<button onClick={reload}>刷新日志</button>}>
    <div className="metric-grid four"><Metric label="累计日志" value={data.summary.totalLogs}/><Metric label="今日操作" value={data.summary.today}/><Metric label="近7天" value={data.summary.last7Days}/><Metric label="近30天导入/恢复" value={data.summary.metrics?.importCount30} tone="warning"/></div>
    <Card title="高风险操作" kicker="HIGH RISK"><Table columns={[{key:'username',label:'用户',render:v=>v||'system'},{key:'action',label:'动作',render:v=><Badge tone="warning">{v}</Badge>},{key:'target',label:'对象'},{key:'detail',label:'详情',render:v=><code className="clip">{typeof v==='string'?v:JSON.stringify(v)}</code>},{key:'created_at',label:'时间',render:dateTime}]} rows={data.summary.highRiskActions||[]}/></Card>
    <Card title="全部操作日志" kicker="ALL EVENTS"><Table columns={[{key:'username',label:'用户',render:v=>v||'system'},{key:'action',label:'动作'},{key:'target',label:'对象'},{key:'ip',label:'来源IP'},{key:'created_at',label:'时间',render:dateTime}]} rows={data.logs.rows||[]}/></Card>
  </Page>
}

function Recovery() {
  const {data,loading,error,reload}=useLoad(async()=>{const [dr,backups,system,quarantine]=await Promise.all([api('/api/governance/disaster-recovery'),api('/api/import/backups'),api('/api/admin/system'),api('/api/admin/quarantine')]);return{dr,backups,system,quarantine}},[])
  const [restoring,setRestoring]=useState(null)
  if(loading)return <Loading/>;if(error)return <ErrorState message={error} retry={reload}/>
  const restore=async()=>{if(prompt('该操作会替换项目经营表。请输入“恢复项目数据”确认：')!=='恢复项目数据')return;try{await api(`/api/import/backups/${restoring.id}/restore`,{method:'POST',body:JSON.stringify({confirmNote:'管理后台人工确认恢复'})});setRestoring(null);reload();alert('项目数据已恢复并记录审计')}catch(e){alert(e.message)}}
  const s=data.dr.summary||{}
  return <Page eyebrow="DISASTER RECOVERY" title="灾备与恢复" description="备份不等于可恢复：同时检查校验、时效和演练状态" action={<button onClick={reload}>刷新状态</button>}>
    <div className="metric-grid six"><Metric label="数据库完整性" value={data.system.database?.integrity} tone={data.system.database?.integrity==='ok'?'success':'danger'}/><Metric label="本机备份" value={s.count??'—'}/><Metric label="隔离记录" value={data.quarantine.summary?.quarantined??0} tone={data.quarantine.summary?.quarantined?'warning':''}/><Metric label="备份健康" value={s.backupHealthy?'通过':'未通过'} tone={s.backupHealthy?'success':'danger'}/><Metric label="恢复验证" value={s.restoreHealthy?'通过':'未通过'} tone={s.restoreHealthy?'success':'warning'}/><Metric label="异地备份" value={s.offsiteBackupHealthy?'通过':'未通过'} tone={s.offsiteBackupHealthy?'success':'warning'}/></div>
    <div className="layout-1-1"><Card title="最近备份状态" kicker="BACKUP STATUS"><div className="kv"><div><span>状态</span><b>{data.dr.backupStatus?.status||'—'}</b></div><div><span>完成时间</span><b>{dateTime(data.dr.backupStatus?.finished_at)}</b></div><div><span>距今小时</span><b>{s.backupAgeHours==null?'—':s.backupAgeHours.toFixed(1)}</b></div><div><span>SLA</span><b>{s.backupSlaHours||26}小时</b></div></div></Card><Card title="最近恢复验证" kicker="RESTORE DRILL"><div className="kv"><div><span>状态</span><b>{data.dr.restoreStatus?.status||'—'}</b></div><div><span>完成时间</span><b>{dateTime(data.dr.restoreStatus?.finished_at)}</b></div><div><span>距今小时</span><b>{s.restoreAgeHours==null?'—':s.restoreAgeHours.toFixed(1)}</b></div><div><span>数据库模式</span><b>{data.system.database?.wal||'—'}</b></div></div></Card></div>
    <Card title="数据真实性隔离批次" kicker="QUARANTINE"><div className="notice">隔离记录已从业务接口移出，但原始JSON仍保留在数据库中。恢复必须经过业务确认和数据库备份，不开放浏览器一键操作。</div><Table columns={[{key:'batch_key',label:'隔离批次',render:v=><code>{v}</code>},{key:'record_count',label:'记录数'},{key:'table_count',label:'涉及表'},{key:'status',label:'状态',render:v=><Badge tone="warning">{v}</Badge>},{key:'quarantined_by',label:'操作人'},{key:'quarantined_at',label:'隔离时间',render:dateTime}]} rows={data.quarantine.batches||[]}/></Card>
    <Card title="项目数据备份" kicker="CONTROLLED RESTORE"><div className="notice">整库恢复不开放浏览器直接执行，避免误覆盖生产数据库；以下仅允许恢复项目经营表快照，并要求二次确认。</div><Table columns={[{key:'source',label:'备份来源'},{key:'row_count',label:'项目数'},{key:'created_at',label:'创建时间',render:dateTime},{key:'id',label:'操作',render:(_,r)=><button className="link" onClick={()=>setRestoring(r)}>准备恢复</button>}]} rows={data.backups.rows||[]}/></Card>
    {restoring&&<Modal title="恢复项目数据" onClose={()=>setRestoring(null)}><div className="alert warning"><b>高风险操作</b><p>将用备份“{restoring.source}”替换当前项目经营表。系统会留下审计记录，但可能影响AI、预测和归档。</p></div><div className="modal-actions"><button onClick={()=>setRestoring(null)}>取消</button><button className="danger-button" onClick={restore}>继续并输入确认词</button></div></Modal>}
  </Page>
}

function Archives() {
  const {data,loading,error,reload}=useLoad(async()=>{const [reports,outputs]=await Promise.all([api('/api/governance/report-archives'),api('/api/formal-outputs')]);return{reports,outputs}},[])
  if(loading)return <Loading/>;if(error)return <ErrorState message={error} retry={reload}/>
  return <Page eyebrow="EVIDENCE ARCHIVE" title="归档与输出" description="月报版本、来源证据和正式成果统一留档" action={<button onClick={reload}>刷新归档</button>}>
    <div className="metric-grid three"><Metric label="月报归档" value={data.reports.rows?.length||0}/><Metric label="正式输出" value={data.outputs.rows?.length||0}/><Metric label="不可变归档" value="已启用" tone="success"/></div>
    <Card title="月报归档" kicker="REPORT ARCHIVES"><Table columns={[{key:'report_date',label:'报告日期'},{key:'area',label:'范围'},{key:'version',label:'版本',render:v=><Badge>{v}</Badge>},{key:'archive_version',label:'归档版本'},{key:'title',label:'标题'},{key:'created_by',label:'归档人'},{key:'created_at',label:'归档时间',render:dateTime}]} rows={data.reports.rows||[]}/></Card>
    <Card title="正式输出文件" kicker="FORMAL OUTPUTS"><Table columns={[{key:'type',label:'类型'},{key:'area',label:'范围'},{key:'period',label:'期间'},{key:'title',label:'标题'},{key:'created_by',label:'创建人'},{key:'created_at',label:'创建时间',render:dateTime}]} rows={data.outputs.rows||[]}/></Card>
  </Page>
}

const PAGES={overview:Overview,quality:Quality,sources:Sources,mappings:Mappings,rules:Rules,users:Users,audit:Audit,recovery:Recovery,archives:Archives}
function Shell({user,onLogout}) {
  const [page,setPage]=useState(()=>location.hash.slice(1)||'overview'); const [mobile,setMobile]=useState(false); const [expanded,setExpanded]=useState(false)
  useEffect(()=>{const fn=()=>setPage(location.hash.slice(1)||'overview');addEventListener('hashchange',fn);return()=>removeEventListener('hashchange',fn)},[])
  const go=id=>{location.hash=id;setPage(id);setMobile(false)}; const Current=PAGES[page]||Overview; const current=NAV.find(x=>x[0]===page)||NAV[0]
  return <div className="app-shell">
    <header className="aph-admin-header">
      <a className="aph-admin-brand" href="/" aria-label="返回驾驶舱首页"><img src="/aph-icons/aph-brand-lockup.jpg" alt="APH 2.0" /></a>
      <button className="desktop-menu" type="button" aria-label="展开或收起导航" aria-controls="admin-navigation" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><i/><i/><i/></button>
      <p>华北年度经营冲刺　·　系统后台管理</p>
      <div className="aph-admin-actions"><img src="/aph-icons/jurassic_users.png" alt=""/><span><b>{user.username}</b><small>{roleLabel(user.role)}</small></span><a href="/system/">系统管理</a><button className="header-logout" onClick={onLogout}>退出</button></div>
    </header>
    <aside id="admin-navigation" className={`${expanded?'is-expanded ':''}${mobile?'open':''}`.trim()} aria-label="系统管理功能，鼠标移入自动展开">
      <nav>{NAV.map(([id,icon,label,desc])=><button key={id} title={label} className={page===id?'active':''} aria-current={page===id?'page':undefined} onClick={()=>go(id)}><i><img src={icon} alt=""/></i><span><b>{label}</b><small>{desc}</small></span></button>)}</nav>
    </aside>
    <div className="mobile-mask" onClick={()=>setMobile(false)}/>
    <main className="workspace">
      <header className="topbar">
        <button className="menu" aria-label={mobile?'关闭系统管理导航':'打开系统管理导航'} aria-expanded={mobile} onClick={()=>setMobile(!mobile)}><i/><i/><i/></button>
        <span className="tab-prev" aria-hidden="true"><img src="/aph-icons/aph-tab-prev.jpg" alt=""/></span>
        <a href="/">首页</a><a href="/system/">系统管理</a><b>{current[2]}</b>
      </header>
      <div className="content"><Current/></div>
    </main>
  </div>
}

export default function App(){
  const [auth,setAuth]=useState({checking:true,user:null})
  useEffect(()=>{if(!getToken()){setAuth({checking:false,user:null});return}api('/api/auth/me').then(r=>{if(r.user?.role!=='admin')throw new Error('not admin');setAuth({checking:false,user:r.user})}).catch(()=>{clearToken();setAuth({checking:false,user:null})})},[])
  if(auth.checking)return <div className="boot"><img className="boot-logo" src="/aph-icons/aph-brand-lockup.jpg" alt="APH 2.0"/><span>正在验证管理权限…</span></div>
  if(!auth.user)return <Login onLogin={user=>setAuth({checking:false,user})}/>
  return <Shell user={auth.user} onLogout={()=>{clearToken();setAuth({checking:false,user:null})}}/>
}
