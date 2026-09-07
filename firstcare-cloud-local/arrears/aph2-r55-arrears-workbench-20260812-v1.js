/* R55：欠费台账与沟通记录AI分析工作区。 */
(() => {
  'use strict'

  const token = localStorage.getItem('cockpit_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || ''
  if (!token) return

  const $ = (id) => document.getElementById(id)
  const categoryLabels = {
    service_dispute: '服务争议',
    charge_dispute: '收费争议',
    vacancy: '房屋空置',
    financial_hardship: '支付困难',
    ownership_or_handover: '产权/交付问题',
    contact_barrier: '联系障碍',
    promised_payment: '已承诺缴费',
    legal_dispute: '法律争议',
    unknown: '待人工核验',
  }
  const statusLabels = {
    parsed: ['待AI分析', 'is-warn'],
    analyzing: ['AI分析中', 'is-warn'],
    analyzed: ['AI完成', 'is-ok'],
    rule_only: ['规则结果', 'is-warn'],
    revoked: ['已撤回', 'is-bad'],
    blocked: ['已阻断', 'is-bad'],
    running: ['运行中', 'is-warn'],
    completed: ['已完成', 'is-ok'],
    partial: ['部分通过', 'is-warn'],
    failed: ['失败', 'is-bad'],
    discarded: ['已丢弃', 'is-bad'],
    pending: ['待复核', 'is-warn'],
    confirmed: ['已确认', 'is-ok'],
    rejected: ['已驳回', 'is-bad'],
  }
  const terminalRunStatuses = new Set(['completed', 'partial', 'failed', 'discarded'])
  const state = {
    readiness: null,
    projects: [],
    batches: [],
    selectedBatch: null,
    results: [],
    selectedResult: null,
    pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
    pollers: new Map(),
    inspectorInerted: [],
    returnFocus: null,
    modalReturnFocus: null,
  }

  function element(tag, text, className) {
    const node = document.createElement(tag)
    if (text !== undefined && text !== null) node.textContent = String(text)
    if (className) node.className = className
    return node
  }

  function clear(node) {
    node.replaceChildren()
    return node
  }

  function makeButton(text, className, handler) {
    const node = element('button', text, className)
    node.type = 'button'
    node.addEventListener('click', handler)
    return node
  }

  function todayLocal() {
    const date = new Date()
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  function announce(message) {
    const live = $('r55Announcer')
    live.textContent = ''
    window.setTimeout(() => { live.textContent = message }, 20)
  }

  function redirectToLogin() {
    const target = '/login?redirect=' + encodeURIComponent('/arrears')
    if (window.top && window.top !== window) window.top.location.replace(target)
    else window.location.replace(target)
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {})
    headers.set('Authorization', `Bearer ${token}`)
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    const response = await fetch(path, { ...options, headers })
    if (response.status === 401) {
      localStorage.removeItem('cockpit_token')
      redirectToLogin()
      throw Object.assign(new Error('登录已失效'), { status: 401, payload: { error: '登录已失效' } })
    }
    const type = response.headers.get('content-type') || ''
    let body
    if (type.includes('application/json')) body = await response.json()
    else if (response.ok) body = await response.blob()
    else body = { error: (await response.text()) || `请求失败 HTTP ${response.status}` }
    if (!response.ok) {
      const error = new Error(body?.error || `请求失败 HTTP ${response.status}`)
      error.status = response.status
      error.payload = body
      throw error
    }
    return { body, response }
  }

  function normalizeDetails(details) {
    if (!Array.isArray(details)) return []
    return details.slice(0, 30).map((item) => {
      if (typeof item === 'string') return item
      try { return JSON.stringify(item) } catch { return String(item) }
    })
  }

  function dismissError() {
    $('r55ErrorPanel').hidden = true
    clear($('r55ErrorDetails'))
    clear($('r55ErrorAction'))
  }

  function showError(error, title = '操作未完成', action = null) {
    const payload = error?.payload || {}
    $('r55ErrorTitle').textContent = title
    $('r55ErrorMessage').textContent = payload.error || error?.message || '请稍后重试'
    const list = clear($('r55ErrorDetails'))
    normalizeDetails(payload.details).forEach((detail) => list.append(element('li', detail)))
    const meta = []
    if (payload.code) meta.push(`错误代码：${payload.code}`)
    if (payload.requestId) meta.push(`请求编号：${payload.requestId}`)
    $('r55ErrorMeta').textContent = meta.join(' · ')
    const actionBox = clear($('r55ErrorAction'))
    if (action?.label && typeof action.handler === 'function') {
      actionBox.append(makeButton(action.label, 'r55-button secondary', action.handler))
    }
    const panel = $('r55ErrorPanel')
    panel.hidden = false
    panel.focus({ preventScroll: true })
    panel.scrollIntoView({ block: 'nearest' })
  }

  function showUploadError(error) {
    const payload = error?.payload || {}
    $('r55UploadFeedbackMessage').textContent = payload.error || error?.message || '请检查文件后重试'
    const list = clear($('r55UploadFeedbackDetails'))
    const details = normalizeDetails(payload.details)
    if (details.length) details.forEach((detail) => list.append(element('li', detail)))
    else list.append(element('li', '原文件仍保留在选择框中，可修正后重新上传。'))
    const panel = $('r55UploadFeedback')
    panel.hidden = false
    panel.focus({ preventScroll: true })
    panel.scrollIntoView({ block: 'nearest' })
  }

  function clearUploadError() {
    $('r55UploadFeedback').hidden = true
    clear($('r55UploadFeedbackDetails'))
  }

  function setButtonBusy(button, busy, busyText) {
    if (busy) {
      button.dataset.idleText = button.textContent
      button.textContent = busyText
      button.disabled = true
      button.setAttribute('aria-busy', 'true')
    } else {
      button.textContent = button.dataset.idleText || button.textContent
      button.disabled = false
      button.removeAttribute('aria-busy')
    }
  }

  function setMode(mode) {
    const resolved = ['tasks', 'overview', 'details'].includes(mode) ? mode : 'tasks'
    document.body.dataset.r55Mode = resolved
    document.querySelectorAll('[data-r55-mode]').forEach((button) => {
      if (button.dataset.r55Mode === resolved) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    })
    $('r55Workbench').hidden = resolved !== 'tasks'
    if (resolved !== 'tasks') {
      document.querySelector(`[data-arrears-tab="${resolved}"]`)?.click()
    }
  }

  function formatMoney(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
    return `¥${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  function formatPercent(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
    const number = Number(value)
    return `${Math.round(number <= 1 ? number * 100 : number)}%`
  }

  function formatFileSize(size) {
    if (!Number.isFinite(Number(size))) return ''
    if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
    return `${Math.max(1, Math.round(size / 1024))}KB`
  }

  function statusBadge(value) {
    const config = statusLabels[value] || [value || '状态未知', '']
    return element('span', config[0], `r55-status ${config[1]}`.trim())
  }

  function progressFrom(value) {
    if (value === null || value === undefined) return null
    if (typeof value === 'number') return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value))
    if (typeof value !== 'object') return null
    const direct = value.percent ?? value.progress ?? value.percentage
    if (Number.isFinite(Number(direct))) return Math.max(0, Math.min(100, Number(direct) <= 1 ? Number(direct) * 100 : Number(direct)))
    const completed = Number(value.completed ?? value.processed ?? value.accepted_count)
    const total = Number(value.total ?? value.expected ?? value.total_count)
    return Number.isFinite(completed) && Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(100, completed / total * 100)) : null
  }

  function readinessLimitText(limits = {}) {
    const values = []
    const maxFile = limits.maxFileSizeMb ?? limits.max_file_size_mb ?? limits.fileSizeMb
    const ledgerRows = limits.maxLedgerRows ?? limits.max_ledger_rows ?? limits.ledgerRows
    const communicationRows = limits.maxCommunicationRows ?? limits.max_communication_rows ?? limits.communicationRows
    const resultPageSize = limits.resultPageSize ?? limits.result_page_size
    if (maxFile) values.push(`单文件${maxFile}MB以内`)
    if (ledgerRows) values.push(`台账最多${Number(ledgerRows).toLocaleString('zh-CN')}行`)
    if (communicationRows) values.push(`沟通最多${Number(communicationRows).toLocaleString('zh-CN')}行`)
    if (resultPageSize) values.push(`结果每页${Number(resultPageSize).toLocaleString('zh-CN')}项`)
    return values.length ? values.join(' · ') : '仅支持xlsx、xls或csv；文件内容必须与扩展名一致'
  }

  function canUpload() {
    const readiness = state.readiness || {}
    if (typeof readiness.uploadReady === 'boolean') return readiness.uploadReady
    const archiveReady = Boolean(readiness.archive?.ready)
    const encryptionReady = readiness.archive?.encryptionReady
    const hashReady = readiness.hash?.ready
    const accessibleProjects = readiness.projects?.accessible
    return archiveReady
      && encryptionReady !== false
      && hashReady !== false
      && (accessibleProjects === undefined || Number(accessibleProjects) > 0)
  }

  function canAnalyze() {
    const readiness = state.readiness || {}
    if (typeof readiness.analysisReady === 'boolean') return readiness.analysisReady
    return Boolean(canUpload() && readiness.ai?.configured)
  }

  function renderReadiness() {
    const readiness = state.readiness || {}
    const archiveReady = canUpload()
    const aiReady = Boolean(readiness.ai?.configured)
    const archive = $('r55ArchiveState')
    const ai = $('r55AiState')
    archive.textContent = archiveReady ? '上传与加密归档可用' : '上传门禁不可用'
    archive.className = archiveReady ? 'is-ok' : 'is-bad'
    ai.textContent = aiReady ? `AI已配置 · ${readiness.ai?.model || '当前模型'}` : 'AI尚未配置'
    ai.className = aiReady ? 'is-ok' : 'is-bad'
    $('r55LimitText').textContent = readinessLimitText(readiness.limits)
    $('r55SubmitBatch').textContent = aiReady ? '上传校验并开始AI分析' : '上传并校验'
    $('r55SubmitBatch').disabled = !canUpload()
    updateSelectedActions()
  }

  async function loadReadiness() {
    const { body } = await request('/api/arrears/readiness')
    state.readiness = body || {}
    renderReadiness()
  }

  async function loadProjects() {
    const { body } = await request('/api/arrears/projects')
    state.projects = body.rows || []
    const select = clear($('r55Project'))
    const placeholder = element('option', '请选择当前账号有权访问的项目')
    placeholder.value = ''
    select.append(placeholder)
    state.projects.forEach((project) => {
      const option = element('option', `${project.area || '未分片区'} · ${project.name}`)
      option.value = project.id
      select.append(option)
    })
  }

  function taskMatches(batch) {
    const query = $('r55TaskSearch').value.trim().toLowerCase()
    const status = $('r55TaskStatus').value
    if (status && batch.status !== status) return false
    if (!query) return true
    return [batch.id, batch.project_name, batch.created_by, batch.business_date]
      .some((value) => String(value || '').toLowerCase().includes(query))
  }

  function taskCell(label) {
    const cell = element('td')
    cell.dataset.label = label
    return cell
  }

  function appendCellText(cell, title, meta = '') {
    cell.append(element('span', title, 'r55-cell-title'))
    if (meta) cell.append(element('span', meta, 'r55-cell-meta'))
  }

  function renderTaskProgress(cell, batch) {
    const value = progressFrom(batch.run_progress)
    const latestRun = batch.latest_run || null
    const displayedStatus = batch.status === 'analyzing' ? 'running' : (latestRun?.status === 'failed' || latestRun?.status === 'partial' ? latestRun.status : batch.status)
    const text = element('span', batch.status === 'analyzing' ? (value === null ? 'AI分析中' : `AI分析中 ${Math.round(value)}%`) : (statusLabels[displayedStatus]?.[0] || displayedStatus || '状态未知'), 'r55-cell-title')
    text.id = `r55RunText-${batch.id}`
    cell.append(text)
    const model = batch.ai_model || latestRun?.model || (batch.active_run_id ? `运行 #${batch.active_run_id}` : '')
    if (model) cell.append(element('span', model, 'r55-cell-meta'))
    const track = element('span', null, 'r55-progress')
    track.id = `r55RunTrack-${batch.id}`
    const bar = element('span')
    bar.style.setProperty('--r55-progress', `${value ?? (batch.status === 'analyzing' ? 4 : 0)}%`)
    track.append(bar)
    if (batch.status === 'analyzing' || value !== null) cell.append(track)
  }

  function renderTasks() {
    const rows = clear($('r55TaskRows'))
    const filtered = state.batches.filter(taskMatches)
    $('r55TaskCount').textContent = `${filtered.length}/${state.batches.length}个任务`
    if (!filtered.length) {
      const tr = element('tr')
      const td = element('td', null, 'r55-empty-state')
      td.colSpan = 6
      if (state.batches.length) {
        td.append(element('strong', '没有符合当前筛选的任务'))
        td.append(element('p', '调整项目、批次或状态条件后重试。'))
        td.append(makeButton('清除筛选', 'r55-button secondary', clearTaskFilters))
      } else {
        td.append(element('strong', '尚未创建AI分析任务'))
        td.append(element('p', '上传欠费台账和沟通记录，系统会先校验再启动只读AI分析。'))
        td.append(makeButton('新建分析', 'r55-button primary', openCreatePanel))
      }
      tr.append(td); rows.append(tr); return
    }
    filtered.forEach((batch) => {
      const tr = element('tr')
      tr.dataset.batchId = batch.id

      const task = taskCell('任务')
      appendCellText(task, `#${batch.id} · ${batch.project_name}`, `业务日期 ${batch.business_date || '—'}`)

      const evidence = taskCell('证据规模')
      appendCellText(evidence, `${Number(batch.result_count ?? batch.matched_resources ?? 0).toLocaleString('zh-CN')}项资源`, `${Number(batch.ledger_rows || 0).toLocaleString('zh-CN')}条台账 · ${Number(batch.communication_rows || 0).toLocaleString('zh-CN')}条沟通`)

      const progress = taskCell('AI进度')
      renderTaskProgress(progress, batch)

      const review = taskCell('人工复核')
      appendCellText(review, `${Number(batch.pending_review_count || 0).toLocaleString('zh-CN')}项待复核`, `${Number(batch.confirmed_review_count || 0).toLocaleString('zh-CN')}项已确认 · ${Number(batch.rejected_review_count || 0).toLocaleString('zh-CN')}项已驳回`)

      const created = taskCell('创建信息')
      appendCellText(created, batch.created_by || '当前账号', batch.created_at || '')

      const actions = taskCell('操作')
      const wrap = element('div', null, 'r55-row-actions')
      wrap.append(makeButton('进入复核', 'r55-row-action primary', (event) => openReview(batch, event.currentTarget)))
      const analyzing = batch.status === 'analyzing' || Boolean(batch.active_run_id)
      if (['parsed', 'rule_only', 'analyzed'].includes(batch.status) || analyzing) {
        const analyze = makeButton(analyzing ? '分析进行中' : (batch.status === 'analyzed' ? '重新分析' : '开始AI'), 'r55-row-action', () => startAnalysis(batch))
        analyze.disabled = analyzing || !canAnalyze()
        analyze.title = !canAnalyze() ? 'AI或加密归档服务当前不可用' : ''
        wrap.append(analyze)
      }
      const exportButton = makeButton('导出确认结果', 'r55-row-action', () => exportConfirmed(batch))
      exportButton.disabled = Number(batch.confirmed_review_count || 0) < 1 || ['analyzing', 'revoked', 'blocked'].includes(batch.status)
      wrap.append(exportButton)
      wrap.append(makeButton('运行记录', 'r55-row-action', (event) => openRunHistory(batch, event.currentTarget)))
      wrap.append(makeButton('审计', 'r55-row-action', (event) => openAudit(batch, event.currentTarget)))
      wrap.append(makeButton('批次管理', 'r55-row-action', (event) => openLifecycle(batch, event.currentTarget)))
      actions.append(wrap)
      tr.append(task, evidence, progress, review, created, actions)
      rows.append(tr)
    })
  }

  async function loadBatches(reportError = true) {
    try {
      const { body } = await request('/api/arrears/batches')
      state.batches = body.rows || []
      if (state.selectedBatch) {
        const fresh = state.batches.find((batch) => Number(batch.id) === Number(state.selectedBatch.id))
        if (fresh) state.selectedBatch = fresh
      }
      renderTasks()
      updateSelectedActions()
      state.batches.filter((batch) => batch.active_run_id).forEach((batch) => trackRun(batch.id, batch.active_run_id))
    } catch (error) {
      if (reportError) showError(error, '分析任务读取失败')
      throw error
    }
  }

  function clearTaskFilters() {
    $('r55TaskSearch').value = ''
    $('r55TaskStatus').value = ''
    renderTasks()
  }

  function openCreatePanel() {
    const panel = $('r55CreatePanel')
    panel.hidden = false
    $('r55NewBatch').setAttribute('aria-expanded', 'true')
    panel.scrollIntoView({ block: 'start' })
    $('r55Project').focus({ preventScroll: true })
  }

  function closeCreatePanel() {
    $('r55CreatePanel').hidden = true
    $('r55NewBatch').setAttribute('aria-expanded', 'false')
    $('r55NewBatch').focus({ preventScroll: true })
  }

  function updateFileMeta(input, target, fallback) {
    const file = input.files?.[0]
    $(target).textContent = file ? `${file.name} · ${formatFileSize(file.size)}` : fallback
  }

  async function downloadTemplate(kind) {
    try {
      const { body, response } = await request(`/api/arrears/templates/${kind}`)
      const disposition = response.headers.get('content-disposition') || ''
      const match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
      const filename = match ? decodeURIComponent(match[1]) : `${kind}.xlsx`
      const url = URL.createObjectURL(body)
      const link = document.createElement('a')
      link.href = url; link.download = filename; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      announce(`${filename}已开始下载`)
    } catch (error) {
      showError(error, '模板下载失败')
    }
  }

  async function createBatch(event) {
    event.preventDefault()
    const form = $('r55CreateForm')
    if (!form.checkValidity()) { form.reportValidity(); return }
    if (!canUpload()) {
      showError(new Error('文件隐私哈希、加密归档或项目权限门禁不可用，已阻止上传'), '无法创建分析任务')
      return
    }
    const button = $('r55SubmitBatch')
    clearUploadError()
    setButtonBusy(button, true, '上传校验中…')
    form.setAttribute('aria-busy', 'true')
    try {
      const payload = new FormData()
      payload.set('projectId', $('r55Project').value)
      payload.set('businessDate', $('r55BusinessDate').value)
      payload.set('ledger', $('r55LedgerFile').files[0])
      payload.set('communications', $('r55CommunicationFile').files[0])
      const { body } = await request('/api/arrears/batches', { method: 'POST', body: payload })
      announce(`批次#${body.batchId}校验通过，已建立分析任务`)
      form.reset()
      $('r55BusinessDate').value = todayLocal()
      updateFileMeta($('r55LedgerFile'), 'r55LedgerMeta', '请选择15MB以内的xlsx、xls或csv文件')
      updateFileMeta($('r55CommunicationFile'), 'r55CommunicationMeta', '资源编码必须与台账一致；记录缺失不等于未联系')
      closeCreatePanel()
      await loadBatches(false)
      const batch = state.batches.find((item) => Number(item.id) === Number(body.batchId)) || { id: body.batchId, status: body.status || 'parsed', project_name: '新建任务', business_date: '', pending_review_count: body.matchedResources || 0 }
      await openReview(batch)
      if (canAnalyze()) await startAnalysis(batch)
      else announce(`批次#${body.batchId}已创建；AI未配置，请在服务恢复后启动分析`)
    } catch (error) {
      showUploadError(error)
      const duplicate = String(error?.message || '').match(/批次#(\d+)/)
      if (duplicate) {
        showError(error, '相同文件已存在', {
          label: `打开已有批次 #${duplicate[1]}`,
          handler: () => {
            const batch = state.batches.find((item) => Number(item.id) === Number(duplicate[1]))
            if (batch) { dismissError(); openReview(batch) }
            else loadBatches().then(() => {
              const fresh = state.batches.find((item) => Number(item.id) === Number(duplicate[1]))
              if (fresh) { dismissError(); openReview(fresh) }
            })
          },
        })
      } else announce('文件校验或上传未完成，请按错误明细修正后重试')
    } finally {
      form.removeAttribute('aria-busy')
      setButtonBusy(button, false)
      button.textContent = state.readiness?.ai?.configured ? '上传校验并开始AI分析' : '上传并校验'
      button.disabled = !canUpload()
    }
  }

  function updateRunProgress(batchId, run) {
    const value = progressFrom(run.run_progress ?? run.progress)
    const text = $(`r55RunText-${batchId}`)
    if (text) text.textContent = run.status === 'running' ? (value === null ? 'AI分析中' : `AI分析中 ${Math.round(value)}%`) : (statusLabels[run.status]?.[0] || run.status || 'AI状态未知')
    const bar = $(`r55RunTrack-${batchId}`)?.firstElementChild
    if (bar) bar.style.setProperty('--r55-progress', `${value ?? (run.status === 'running' ? 4 : 100)}%`)
    if (state.selectedBatch && Number(state.selectedBatch.id) === Number(batchId)) {
      const status = $('r55SelectedRunState')
      status.textContent = run.status === 'running' ? (value === null ? `AI运行 #${run.id || run.runId}` : `AI运行 ${Math.round(value)}%`) : (statusLabels[run.status]?.[0] || run.status || '')
      status.className = `r55-run-state ${run.status === 'running' ? 'is-running' : ''}`.trim()
    }
  }

  function trackRun(batchId, runId) {
    const current = state.pollers.get(Number(batchId))
    if (current?.runId === Number(runId)) return
    if (current?.timer) window.clearTimeout(current.timer)
    const tracker = { runId: Number(runId), timer: null, failures: 0 }
    state.pollers.set(Number(batchId), tracker)

    const poll = async () => {
      try {
        const { body: run } = await request(`/api/arrears/runs/${runId}`)
        tracker.failures = 0
        updateRunProgress(batchId, run)
        if (terminalRunStatuses.has(run.status)) {
          state.pollers.delete(Number(batchId))
          announce(`批次#${batchId}的AI分析${statusLabels[run.status]?.[0] || run.status}`)
          if (run.status === 'failed') {
            const error = new Error(run.error_message || 'AI分析失败，规则结果仍可使用')
            error.payload = { error: error.message, requestId: run.request_id || run.requestId }
            showError(error, `批次#${batchId} AI分析失败`)
          }
          await loadBatches(false)
          if (state.selectedBatch && Number(state.selectedBatch.id) === Number(batchId)) await loadResults({ keepSelection: true })
          return
        }
        tracker.timer = window.setTimeout(poll, 2000)
      } catch (error) {
        tracker.failures += 1
        if (tracker.failures >= 3) {
          state.pollers.delete(Number(batchId))
          showError(error, `批次#${batchId} AI进度读取失败`)
          return
        }
        tracker.timer = window.setTimeout(poll, 5000)
      }
    }
    poll()
  }

  async function startAnalysis(batch) {
    if (!canAnalyze()) {
      showError(new Error('AI或加密归档服务当前不可用'), '无法启动AI分析')
      return
    }
    if (batch.status === 'analyzing' || batch.active_run_id) {
      announce(`批次#${batch.id}已有AI分析正在运行`)
      if (batch.active_run_id) trackRun(batch.id, batch.active_run_id)
      return
    }
    try {
      const { body } = await request(`/api/arrears/batches/${batch.id}/analyze`, { method: 'POST', body: '{}' })
      batch.status = 'analyzing'
      batch.active_run_id = body.runId
      updateRunProgress(batch.id, { id: body.runId, status: body.status || 'running', progress: 0 })
      renderTasks()
      if (!state.selectedBatch || Number(state.selectedBatch.id) !== Number(batch.id)) await openReview(batch)
      else updateSelectedActions()
      trackRun(batch.id, body.runId)
      announce(`批次#${batch.id} AI分析已启动，可离开页面后再返回查看进度`)
    } catch (error) {
      showError(error, `批次#${batch.id} AI分析未启动`)
    }
  }

  function resultQuery(page = state.pagination.page) {
    const params = new URLSearchParams({ page: String(page), limit: '50' })
    const reviewStatus = $('r55ReviewStatus').value
    const cause = $('r55Cause').value
    const query = $('r55ResultSearch').value.trim()
    if (reviewStatus) params.set('reviewStatus', reviewStatus)
    if (cause) params.set('cause', cause)
    if (query) params.set('q', query)
    return params
  }

  function normalizedPagination(payload = {}) {
    const page = Number(payload.page || 1)
    const limit = Number(payload.limit || 50)
    const total = Number(payload.total || payload.totalCount || 0)
    const totalPages = Number(payload.totalPages || payload.pages || Math.max(1, Math.ceil(total / limit)))
    return { page, limit, total, totalPages: Math.max(1, totalPages) }
  }

  async function openReview(batch, returnFocus = null) {
    const changed = !state.selectedBatch || Number(state.selectedBatch.id) !== Number(batch.id)
    state.selectedBatch = batch
    state.returnFocus = returnFocus || document.activeElement
    if (changed) {
      state.pagination.page = 1
      $('r55ResultSearch').value = ''
      $('r55ReviewStatus').value = 'pending'
      $('r55Cause').value = ''
    }
    $('r55ReviewWorkspace').hidden = false
    $('r55ReviewTitle').textContent = `批次 #${batch.id} · ${batch.project_name || '欠费分析任务'}`
    $('r55ReviewSubtitle').textContent = `业务日期 ${batch.business_date || '—'} · 展示台账事实和本地提取的结构化沟通信号`
    updateSelectedActions()
    await loadResults({ page: state.pagination.page })
    $('r55ReviewWorkspace').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  function closeReview() {
    closeInspector(false)
    $('r55ReviewWorkspace').hidden = true
    state.selectedBatch = null
    state.results = []
    state.returnFocus?.focus?.({ preventScroll: true })
  }

  function updateSelectedActions() {
    const batch = state.selectedBatch
    const analyze = $('r55AnalyzeSelected')
    const exportButton = $('r55ExportConfirmed')
    if (!batch) {
      analyze.disabled = true
      exportButton.disabled = true
      return
    }
    const running = batch.status === 'analyzing' || Boolean(batch.active_run_id)
    analyze.textContent = running ? 'AI分析进行中' : (batch.status === 'analyzed' ? '重新分析' : '开始AI分析')
    analyze.disabled = running || !canAnalyze() || ['revoked', 'blocked'].includes(batch.status)
    exportButton.disabled = Number(batch.confirmed_review_count || 0) < 1 || ['analyzing', 'revoked', 'blocked'].includes(batch.status)
    const runState = $('r55SelectedRunState')
    if (running) {
      const progress = progressFrom(batch.run_progress)
      runState.textContent = progress === null ? 'AI分析中' : `AI分析 ${Math.round(progress)}%`
      runState.className = 'r55-run-state is-running'
    } else {
      const latestStatus = ['failed', 'partial'].includes(batch.latest_run?.status) ? batch.latest_run.status : batch.status
      runState.textContent = statusLabels[latestStatus]?.[0] || latestStatus || ''
      runState.className = `r55-run-state ${latestStatus === 'failed' ? 'is-bad' : latestStatus === 'partial' ? 'is-warn' : ''}`.trim()
    }
  }

  function resultCell(label) {
    const cell = element('td')
    cell.dataset.label = label
    return cell
  }

  function renderResults() {
    const tbody = clear($('r55ResultRows'))
    const pagination = state.pagination
    $('r55ResultCount').textContent = `${pagination.total.toLocaleString('zh-CN')}项结果`
    $('r55PageState').textContent = `第${pagination.page}/${pagination.totalPages}页`
    $('r55PrevPage').disabled = pagination.page <= 1
    $('r55NextPage').disabled = pagination.page >= pagination.totalPages
    if (!state.results.length) {
      const tr = element('tr')
      const td = element('td', null, 'r55-empty-state')
      td.colSpan = 5
      td.append(element('strong', '当前筛选下没有资源'))
      td.append(element('p', pagination.total ? '切换页码或调整筛选条件。' : '如果刚完成全部待复核资源，可导出已确认结果；否则请清除筛选。'))
      td.append(makeButton('清除筛选', 'r55-button secondary', clearResultFilters))
      tr.append(td); tbody.append(tr); return
    }
    state.results.forEach((row) => {
      const tr = element('tr')
      tr.dataset.resultId = row.id
      if (state.selectedResult && Number(state.selectedResult.id) === Number(row.id)) tr.classList.add('is-selected')

      const resource = resultCell('资源')
      const resourceButton = makeButton(row.resource_masked || row.resource_ref || `结果#${row.id}`, 'r55-resource-button', (event) => openInspector(row, event.currentTarget, true))
      resource.append(resourceButton, element('span', row.resource_ref || '', 'r55-cell-meta'))

      const facts = resultCell('欠费事实')
      const fact = row.facts || {}
      const feeItems = Array.isArray(fact.feeItems) ? fact.feeItems.join('、') : (fact.feeItems || '费项未知')
      appendCellText(facts, formatMoney(fact.totalAmount), `${feeItems} · 最大账龄${fact.maxAgeingDays ?? '—'}天`)

      const communications = resultCell('沟通信号')
      const communicationRows = Array.isArray(row.communications) ? row.communications : []
      const latest = [...communicationRows].sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')))[0]
      appendCellText(communications, `${communicationRows.length}条记录`, latest ? `最近 ${latest.occurredAt || '日期未知'} · ${latest.channel || '渠道未知'}` : '记录缺失不等于未联系')

      const ai = resultCell('AI结论')
      appendCellText(ai, categoryLabels[row.ai_category] || row.ai_category || '尚未形成AI结论', row.ai_category ? `置信度 ${formatPercent(row.ai_confidence)}` : (row.analysis_status === 'ai_rejected' ? '未通过证据门禁' : '等待AI分析'))

      const review = resultCell('复核状态')
      review.append(statusBadge(row.human_status || 'pending'))
      if (row.reviewed_by || row.reviewed_at) review.append(element('span', [row.reviewed_by, row.reviewed_at].filter(Boolean).join(' · '), 'r55-cell-meta'))
      tr.append(resource, facts, communications, ai, review)
      tbody.append(tr)
    })
  }

  async function loadResults(options = {}) {
    if (!state.selectedBatch) return
    const page = Number(options.page || state.pagination.page || 1)
    try {
      const { body } = await request(`/api/arrears/batches/${state.selectedBatch.id}/results?${resultQuery(page)}`)
      if (body.batch) state.selectedBatch = { ...state.selectedBatch, ...body.batch }
      state.results = body.rows || []
      state.pagination = normalizedPagination(body.pagination)
      if (!state.results.length && state.pagination.page > state.pagination.totalPages) {
        state.pagination.page = state.pagination.totalPages
        return loadResults({ ...options, page: state.pagination.totalPages })
      }
      renderResults()
      updateSelectedActions()
      if (!state.results.length) {
        closeInspector(false)
        return
      }
      let index = 0
      if (Number.isInteger(options.selectIndex)) index = Math.min(options.selectIndex, state.results.length - 1)
      else if (options.keepSelection && state.selectedResult) {
        const matched = state.results.findIndex((row) => Number(row.id) === Number(state.selectedResult.id))
        if (matched >= 0) index = matched
      }
      openInspector(state.results[index], null, false)
    } catch (error) {
      showError(error, `批次#${state.selectedBatch.id} 结果读取失败`)
    }
  }

  function addFact(grid, label, value) {
    const item = element('div')
    item.append(element('dt', label), element('dd', value))
    grid.append(item)
  }

  function evidenceSummary(item = {}) {
    const values = []
    if (item.arrearsAmount !== undefined) values.push(`欠费 ${formatMoney(item.arrearsAmount)}`)
    if (item.feeItem) values.push(item.feeItem)
    if (item.periodStart || item.periodEnd) values.push(`${item.periodStart || '起始未知'}至${item.periodEnd || '截止未知'}`)
    if (item.ageingDays !== undefined && item.ageingDays !== null) values.push(`账龄${item.ageingDays}天`)
    if (item.status) values.push(item.status)
    return values.length ? values.join(' · ') : '台账事实已通过字段门禁'
  }

  function highlightEvidence(reference) {
    document.querySelectorAll('#r55InspectorBody [data-evidence-ref]').forEach((item) => {
      item.classList.toggle('is-highlighted', item.dataset.evidenceRef === reference)
    })
    const target = [...document.querySelectorAll('#r55InspectorBody [data-evidence-ref]')].find((item) => item.dataset.evidenceRef === reference)
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      target.tabIndex = -1
      target.focus({ preventScroll: true })
    }
  }

  function inspectorSection(title) {
    const section = element('section', null, 'r55-inspector-section')
    section.append(element('h5', title))
    return section
  }

  function renderInspector(row) {
    const body = clear($('r55InspectorBody'))
    $('r55InspectorTitle').textContent = row.resource_masked || row.resource_ref || `结果#${row.id}`
    const facts = row.facts || {}

    const factSection = inspectorSection('欠费台账事实')
    const grid = element('dl', null, 'r55-fact-grid')
    addFact(grid, '欠费净额', formatMoney(facts.totalAmount))
    addFact(grid, '最大账龄', facts.maxAgeingDays === null || facts.maxAgeingDays === undefined ? '—' : `${facts.maxAgeingDays}天`)
    addFact(grid, '费项', Array.isArray(facts.feeItems) ? (facts.feeItems.join('、') || '—') : (facts.feeItems || '—'))
    addFact(grid, '欠费期间', `${facts.periodStart || '—'} 至 ${facts.periodEnd || '—'}`)
    addFact(grid, '台账状态', Array.isArray(facts.statuses) ? (facts.statuses.join('、') || '—') : (facts.statuses || '—'))
    addFact(grid, '证据资源', row.resource_ref || '—')
    factSection.append(grid)
    const ledgerList = element('ul', null, 'r55-evidence-list')
    const ledgerItems = Array.isArray(facts.ledgerEvidenceItems) ? facts.ledgerEvidenceItems : []
    ledgerItems.forEach((item) => {
      const li = element('li', null, 'r55-evidence-item')
      const reference = item.ref || item.evidenceRef || ''
      li.dataset.evidenceRef = reference
      li.append(element('code', reference || 'L-?'), element('p', evidenceSummary(item)))
      ledgerList.append(li)
    })
    if (!ledgerItems.length) ledgerList.append(element('li', '当前接口未返回可展开的台账证据行', 'r55-evidence-item'))
    factSection.append(ledgerList)
    body.append(factSection)

    const communicationSection = inspectorSection('结构化沟通信号')
    const communicationList = element('ol', null, 'r55-communication-list')
    const communications = Array.isArray(row.communications) ? row.communications : []
    communications.forEach((item) => {
      const li = element('li', null, 'r55-communication-item')
      const reference = item.ref || ''
      li.dataset.evidenceRef = reference
      li.append(element('code', reference || 'C-?'))
      li.append(element('p', `${item.occurredAt || '日期未知'} · ${item.channel || '渠道未知'}`))
      li.append(element('p', item.content || '沟通内容为空'))
      communicationList.append(li)
    })
    if (!communications.length) communicationList.append(element('li', '未提取匹配沟通信号；这不等于未联系，必须人工核验。', 'r55-communication-item'))
    communicationSection.append(communicationList)
    body.append(communicationSection)

    const aiSection = inspectorSection('AI归因与证据引用')
    const result = element('div', null, 'r55-ai-result')
    result.append(element('strong', row.ai_category ? `${categoryLabels[row.ai_category] || row.ai_category} · 置信度 ${formatPercent(row.ai_confidence)}` : '尚未形成可用AI归因'))
    result.append(element('p', row.ai_reason || (row.analysis_status === 'ai_rejected' ? '本轮AI结果未通过证据完整性门禁，当前保留规则归类。' : '等待AI分析。')))
    const refs = Array.isArray(row.ai_evidence_json) ? row.ai_evidence_json : []
    if (refs.length) {
      const links = element('div', null, 'r55-evidence-links')
      refs.forEach((reference) => links.append(makeButton(reference, 'r55-evidence-ref', () => highlightEvidence(reference))))
      result.append(links)
    }
    aiSection.append(result)
    const rule = element('p', `规则预归类：${categoryLabels[row.rule_category] || row.rule_category || '待人工核验'} · 置信度 ${formatPercent(row.rule_confidence)}`, 'r55-review-meta')
    aiSection.append(rule)
    body.append(aiSection)

    const reviewSection = inspectorSection('人工复核')
    const form = element('form', null, 'r55-review-form')
    form.id = 'r55HumanReviewForm'
    form.addEventListener('submit', (event) => event.preventDefault())
    const categoryLabel = element('label', '人工确认原因')
    const category = element('select')
    category.id = 'r55HumanCategory'
    Object.entries(categoryLabels).forEach(([key, label]) => {
      const option = element('option', label); option.value = key; category.append(option)
    })
    category.value = row.human_category || row.ai_category || row.rule_category || 'unknown'
    categoryLabel.append(category)

    const noteLabel = element('label', '人工核验说明')
    const note = element('textarea')
    note.id = 'r55HumanNote'; note.maxLength = 500; note.required = true
    note.placeholder = '记录核验依据、与AI结论的差异或后续处置边界'
    note.value = row.human_note || ''
    noteLabel.append(note)
    const count = element('span', `${note.value.length}/500`, 'r55-character-count')
    note.addEventListener('input', () => { count.textContent = `${note.value.length}/500` })

    const meta = element('p', null, 'r55-review-meta')
    if (row.human_status && row.human_status !== 'pending') meta.textContent = `${statusLabels[row.human_status]?.[0] || row.human_status} · ${row.reviewed_by || '复核人未知'} · ${row.reviewed_at || '时间未知'}`
    else meta.textContent = 'AI结论只作线索，必须由有权限的业务人员确认后才能导出。'

    const submit = element('div', null, 'r55-review-submit')
    const confirm = makeButton('确认并下一条', 'r55-button primary', () => saveReview('confirmed'))
    confirm.id = 'r55ConfirmNext'
    const reject = makeButton('驳回并下一条', 'r55-button danger', () => saveReview('rejected'))
    reject.id = 'r55RejectNext'
    const reviewLocked = ['analyzing', 'revoked', 'blocked'].includes(state.selectedBatch?.status)
    if (reviewLocked) {
      category.disabled = true
      note.disabled = true
      confirm.disabled = true
      reject.disabled = true
      meta.textContent = state.selectedBatch?.status === 'analyzing'
        ? '本轮AI分析进行中，完成前暂停人工复核，避免结论版本交叉。'
        : '该批次当前为只读状态，只能查看证据、运行记录和审计记录。'
    }
    submit.append(confirm, reject)
    form.append(categoryLabel, noteLabel, count, meta, submit)
    reviewSection.append(form)
    body.append(reviewSection)
  }

  function updateInspectorMode() {
    const inspector = $('r55Inspector')
    if (window.matchMedia('(max-width: 860px)').matches && !inspector.hidden) {
      inspector.setAttribute('role', 'dialog')
      inspector.setAttribute('aria-modal', 'true')
      isolateInspector(true)
    } else {
      inspector.setAttribute('role', 'complementary')
      inspector.removeAttribute('aria-modal')
      isolateInspector(false)
    }
  }

  function isolateInspector(enable) {
    state.inspectorInerted.forEach((node) => { node.inert = false })
    state.inspectorInerted = []
    document.body.classList.toggle('r55-inspector-modal', enable)
    if (!enable) return
    let current = $('r55Inspector')
    while (current?.parentElement && current.parentElement !== document.documentElement) {
      const parent = current.parentElement
      ;[...parent.children].forEach((sibling) => {
        if (sibling === current || sibling.inert || ['SCRIPT', 'STYLE'].includes(sibling.tagName)) return
        sibling.inert = true
        state.inspectorInerted.push(sibling)
      })
      current = parent
      if (current === document.body) break
    }
  }

  function openInspector(row, returnFocus = null, focusInspector = false) {
    state.selectedResult = row
    if (returnFocus) state.returnFocus = returnFocus
    $('r55Inspector').hidden = false
    renderInspector(row)
    updateInspectorMode()
    document.querySelectorAll('#r55ResultRows tr').forEach((tr) => tr.classList.toggle('is-selected', Number(tr.dataset.resultId) === Number(row.id)))
    if (window.matchMedia('(max-width: 860px)').matches && (focusInspector || !$('r55Inspector').contains(document.activeElement))) $('r55CloseInspector').focus({ preventScroll: true })
  }

  function closeInspector(restoreFocus = true) {
    const inspector = $('r55Inspector')
    if (inspector.hidden) return
    inspector.hidden = true
    inspector.removeAttribute('aria-modal')
    isolateInspector(false)
    state.selectedResult = null
    document.querySelectorAll('#r55ResultRows tr').forEach((tr) => tr.classList.remove('is-selected'))
    if (restoreFocus) state.returnFocus?.focus?.({ preventScroll: true })
  }

  async function saveReview(status) {
    const row = state.selectedResult
    if (!row) return
    if (['analyzing', 'revoked', 'blocked'].includes(state.selectedBatch?.status)) {
      showError(new Error('当前批次处于只读状态，不能提交人工复核'), '人工复核未保存')
      return
    }
    const category = $('r55HumanCategory').value
    const note = $('r55HumanNote').value.trim()
    if (!note) {
      showError(new Error('请填写人工核验说明'), '人工复核未保存')
      $('r55HumanNote').focus()
      return
    }
    const currentIndex = Math.max(0, state.results.findIndex((item) => Number(item.id) === Number(row.id)))
    const confirm = $('r55ConfirmNext'); const reject = $('r55RejectNext')
    confirm.disabled = true; reject.disabled = true
    try {
      await request(`/api/arrears/results/${row.id}/review`, { method: 'PUT', body: JSON.stringify({ status, category, note }) })
      announce(`${row.resource_masked || row.resource_ref}已${status === 'confirmed' ? '确认' : '驳回'}，正在打开下一条`)
      await loadBatches(false)
      await loadResults({ page: state.pagination.page, selectIndex: currentIndex })
    } catch (error) {
      showError(error, '人工复核未保存')
      confirm.disabled = false; reject.disabled = false
    }
  }

  function clearResultFilters() {
    $('r55ResultSearch').value = ''
    $('r55ReviewStatus').value = ''
    $('r55Cause').value = ''
    state.pagination.page = 1
    loadResults({ page: 1 })
  }

  async function exportConfirmed(batch = state.selectedBatch) {
    if (!batch) return
    if (['analyzing', 'revoked', 'blocked'].includes(batch.status)) {
      showError(new Error('当前批次状态不允许导出正式确认结果'), `批次#${batch.id} 导出已阻止`)
      return
    }
    try {
      const { body, response } = await request(`/api/arrears/batches/${batch.id}/export`)
      const disposition = response.headers.get('content-disposition') || ''
      const match = disposition.match(/filename\*=UTF-8''([^;]+)/i) || disposition.match(/filename="?([^";]+)"?/i)
      const filename = match ? decodeURIComponent(match[1]) : `欠费AI人工确认结果_批次${batch.id}.csv`
      const url = URL.createObjectURL(body)
      const link = document.createElement('a')
      link.href = url; link.download = filename; link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      announce(`批次#${batch.id}已确认结果开始下载；未确认AI结论未进入文件`)
    } catch (error) {
      showError(error, `批次#${batch.id} 导出失败`)
    }
  }

  function ensureModal() {
    let modal = $('r55Modal')
    if (modal) return modal
    modal = element('dialog', null, 'r55-modal')
    modal.id = 'r55Modal'
    modal.setAttribute('aria-labelledby', 'r55ModalTitle')
    const header = element('header')
    const title = element('h3', '记录', null); title.id = 'r55ModalTitle'
    const close = makeButton('×', 'r55-icon-button', () => modal.close())
    close.setAttribute('aria-label', '关闭对话框')
    header.append(title, close)
    const body = element('div', null, 'r55-modal-body'); body.id = 'r55ModalBody'
    modal.append(header, body)
    modal.addEventListener('close', () => state.modalReturnFocus?.focus?.({ preventScroll: true }))
    $('r55Shell').append(modal)
    return modal
  }

  function showModal(title, returnFocus, renderer) {
    const modal = ensureModal()
    state.modalReturnFocus = returnFocus || document.activeElement
    $('r55ModalTitle').textContent = title
    const body = clear($('r55ModalBody'))
    renderer(body)
    if (typeof modal.showModal === 'function') modal.showModal()
    else modal.setAttribute('open', '')
  }

  function appendDialogRecord(list, label, value) {
    const item = element('div')
    item.append(element('dt', label), element('dd', value || '—'))
    list.append(item)
  }

  function readableDetail(value) {
    if (!value) return '—'
    if (typeof value === 'string') {
      try { return readableDetail(JSON.parse(value)) } catch { return value }
    }
    if (typeof value !== 'object') return String(value)
    return Object.entries(value).map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join('、') : String(item)}`).join('；')
  }

  async function openRunHistory(batch, returnFocus) {
    try {
      const { body } = await request(`/api/arrears/batches/${batch.id}/runs?limit=20`)
      const rows = body.rows || []
      showModal(`批次 #${batch.id} · AI运行记录`, returnFocus, (container) => {
        if (!rows.length) { container.append(element('p', '尚无AI运行记录', 'r55-dialog-empty')); return }
        rows.forEach((run) => {
          const list = element('dl', null, 'r55-dialog-list')
          appendDialogRecord(list, `运行 #${run.id}`, statusLabels[run.status]?.[0] || run.status)
          appendDialogRecord(list, '模型', run.model)
          appendDialogRecord(list, '结果', `${Number(run.accepted_count || 0)}项通过 · ${Number(run.rejected_count || 0)}项拒绝`)
          appendDialogRecord(list, '发起', `${run.started_by || '—'} · ${run.started_at || '—'}`)
          appendDialogRecord(list, '完成', run.completed_at)
          if (run.error_message) appendDialogRecord(list, '失败说明', run.error_message)
          container.append(list)
        })
      })
    } catch (error) {
      showError(error, `批次#${batch.id} AI运行记录读取失败`)
    }
  }

  async function openAudit(batch, returnFocus) {
    try {
      const { body } = await request(`/api/arrears/batches/${batch.id}/audit`)
      const rows = body.rows || []
      showModal(`批次 #${batch.id} · 审计记录`, returnFocus, (container) => {
        if (!rows.length) { container.append(element('p', '当前批次暂无可见审计记录', 'r55-dialog-empty')); return }
        rows.forEach((record) => {
          const list = element('dl', null, 'r55-dialog-list')
          appendDialogRecord(list, record.action || '操作', record.created_at || record.timestamp)
          appendDialogRecord(list, '操作人', record.username || record.created_by)
          appendDialogRecord(list, '对象', record.target)
          appendDialogRecord(list, '说明', readableDetail(record.detail))
          container.append(list)
        })
      })
    } catch (error) {
      showError(error, `批次#${batch.id} 审计记录读取失败`)
    }
  }

  function openLifecycle(batch, returnFocus) {
    showModal(`批次 #${batch.id} · 批次管理`, returnFocus, (container) => {
      const summary = element('p', batch.status === 'revoked' ? '该批次已撤回，不进入经营汇总。恢复前会再次核验加密原始文件。' : '撤回后停止分析并排除出经营汇总；留存期内且原始密文存在时可恢复。')
      container.append(summary)
      const label = element('label', batch.status === 'revoked' ? '操作原因' : '撤回原因')
      const note = element('textarea'); note.id = 'r55LifecycleNote'; note.maxLength = 300; note.required = true
      note.placeholder = '请填写300字以内的业务原因'
      label.append(note); container.append(label)
      const actions = element('div', null, 'r55-form-actions')
      if (batch.status === 'revoked' && !batch.archive_deleted_at) {
        actions.append(makeButton('恢复批次', 'r55-button primary', () => performLifecycle(batch, 'restore')))
        const consentLabel = element('label')
        const consent = element('input'); consent.type = 'checkbox'; consent.id = 'r55ArchiveDeleteConsent'
        consentLabel.append(consent, document.createTextNode('我已了解原始密文删除后不可恢复'))
        container.append(consentLabel)
        const remove = makeButton('永久删除原始密文', 'r55-button danger', () => performLifecycle(batch, 'archive'))
        remove.disabled = true
        consent.addEventListener('change', () => { remove.disabled = !consent.checked })
        actions.append(remove)
      } else if (batch.status !== 'revoked' && !['blocked', 'analyzing'].includes(batch.status)) {
        actions.append(makeButton('撤回批次', 'r55-button danger', () => performLifecycle(batch, 'revoke')))
      } else {
        actions.append(element('p', batch.archive_deleted_at ? `原始密文已于${batch.archive_deleted_at}删除，无法恢复。` : '当前状态不允许执行批次变更。', 'r55-review-meta'))
      }
      container.append(actions)
    })
  }

  async function performLifecycle(batch, action) {
    const note = $('r55LifecycleNote')?.value.trim() || ''
    if (!note) { $('r55LifecycleNote')?.focus(); announce('请填写批次管理原因'); return }
    const config = {
      revoke: { path: `/api/arrears/batches/${batch.id}/revoke`, method: 'POST', message: '已撤回' },
      restore: { path: `/api/arrears/batches/${batch.id}/restore`, method: 'POST', message: '已恢复' },
      archive: { path: `/api/arrears/batches/${batch.id}/archive`, method: 'DELETE', message: '原始密文已永久删除' },
    }[action]
    try {
      await request(config.path, { method: config.method, body: JSON.stringify({ note }) })
      $('r55Modal')?.close()
      announce(`批次#${batch.id}${config.message}`)
      await loadBatches(false)
      if (state.selectedBatch && Number(state.selectedBatch.id) === Number(batch.id)) closeReview()
    } catch (error) {
      $('r55Modal')?.close()
      showError(error, `批次#${batch.id} 操作未完成`)
    }
  }

  function trapInspectorFocus(event) {
    const inspector = $('r55Inspector')
    if (inspector.hidden || !window.matchMedia('(max-width: 860px)').matches) return
    if (event.key === 'Escape') { event.preventDefault(); closeInspector(); return }
    if (event.key !== 'Tab') return
    const focusable = [...inspector.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((node) => node.getClientRects().length)
    if (!focusable.length) return
    const first = focusable[0]; const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  function bindEvents() {
    document.querySelectorAll('[data-r55-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.r55Mode)))
    $('r55DismissError').addEventListener('click', dismissError)
    $('r55NewBatch').addEventListener('click', () => $('r55CreatePanel').hidden ? openCreatePanel() : closeCreatePanel())
    $('r55CancelCreate').addEventListener('click', closeCreatePanel)
    $('r55CreateForm').addEventListener('submit', createBatch)
    $('r55LedgerFile').addEventListener('change', () => updateFileMeta($('r55LedgerFile'), 'r55LedgerMeta', '请选择15MB以内的xlsx、xls或csv文件'))
    $('r55CommunicationFile').addEventListener('change', () => updateFileMeta($('r55CommunicationFile'), 'r55CommunicationMeta', '资源编码必须与台账一致；记录缺失不等于未联系'))
    document.querySelectorAll('[data-r55-template]').forEach((button) => button.addEventListener('click', () => downloadTemplate(button.dataset.r55Template)))
    $('r55RefreshTasks').addEventListener('click', () => Promise.all([loadReadiness(), loadBatches()]).then(() => announce('分析任务已刷新')).catch(() => {}))
    $('r55TaskSearch').addEventListener('input', renderTasks)
    $('r55TaskStatus').addEventListener('change', renderTasks)
    $('r55ClearTaskFilters').addEventListener('click', clearTaskFilters)
    $('r55CloseReview').addEventListener('click', closeReview)
    $('r55AnalyzeSelected').addEventListener('click', () => state.selectedBatch && startAnalysis(state.selectedBatch))
    $('r55ExportConfirmed').addEventListener('click', () => exportConfirmed())
    $('r55RunHistory').addEventListener('click', (event) => state.selectedBatch && openRunHistory(state.selectedBatch, event.currentTarget))
    $('r55AuditTrail').addEventListener('click', (event) => state.selectedBatch && openAudit(state.selectedBatch, event.currentTarget))
    $('r55ApplyResultFilters').addEventListener('click', () => { state.pagination.page = 1; loadResults({ page: 1 }) })
    $('r55ClearResultFilters').addEventListener('click', clearResultFilters)
    $('r55ResultSearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); state.pagination.page = 1; loadResults({ page: 1 }) } })
    $('r55PrevPage').addEventListener('click', () => loadResults({ page: state.pagination.page - 1 }))
    $('r55NextPage').addEventListener('click', () => loadResults({ page: state.pagination.page + 1 }))
    $('r55CloseInspector').addEventListener('click', () => closeInspector())
    document.addEventListener('keydown', trapInspectorFocus)
    window.matchMedia('(max-width: 860px)').addEventListener?.('change', updateInspectorMode)
  }

  async function start() {
    bindEvents()
    $('r55BusinessDate').value = todayLocal()
    document.body.dataset.r55Ready = 'true'
    setMode('tasks')
    const results = await Promise.allSettled([loadReadiness(), loadProjects(), loadBatches(false)])
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length) showError(failures[0].reason, '欠费AI工作区初始化不完整')
  }

  start().catch((error) => showError(error, '欠费AI工作区启动失败'))
})()
