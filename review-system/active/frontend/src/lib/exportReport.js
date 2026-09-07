function escapeHtml(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeText(value = '', fallback = '无') {
  const text = String(value ?? '').trim()
  return text ? escapeHtml(text) : fallback
}

function list(items = [], emptyText = '无') {
  if (!items.length) return `<p class="empty">${escapeHtml(emptyText)}</p>`
  return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
}

function badge(text = '', tone = 'blue') {
  return `<span class="badge badge-${tone}">${escapeHtml(text)}</span>`
}

function buildEvidenceBlocks(evidence = []) {
  if (!evidence.length) return '<p class="empty">无</p>'
  return evidence.map(item => `
    <div class="evidence-item">
      <div class="evidence-meta">${escapeHtml(item.sourceType)} · ${escapeHtml(item.sourceLabel)}</div>
      <div class="evidence-snippet">${escapeHtml(item.snippet || '无证据片段')}</div>
    </div>
  `).join('')
}

function buildKnowledgeHitCards(items = [], showProfile = false) {
  if (!items.length) return '<p class="empty">无</p>'
  return items.map(hit => `
    <div class="hit-card">
      <div class="hit-head">
        <div class="hit-tags">
          ${badge(hit.clauseCode || '未编号', 'emerald')}
          ${showProfile ? badge(hit.profileName || hit.profileId || '未标注专业', 'blue') : ''}
        </div>
        <div class="hit-title">${escapeHtml(hit.title || '未命名条款')}</div>
      </div>
      <div class="hit-content">${escapeHtml(hit.content || '无条款内容')}</div>
      ${(hit.matchedKeywords || []).length > 0 ? `
        <div class="keyword-row">
          ${(hit.matchedKeywords || []).map(keyword => `<span class="keyword">命中：${escapeHtml(keyword)}</span>`).join('')}
        </div>
      ` : ''}
      <div class="evidence-list">
        ${buildEvidenceBlocks(hit.evidence || [])}
      </div>
    </div>
  `).join('')
}

function buildAttachmentRows(files = []) {
  if (!files.length) {
    return `
      <tr>
        <td colspan="4" class="empty-cell">无附件</td>
      </tr>
    `
  }

  return files.map((file, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(file.name || '未命名附件')}</td>
      <td>${escapeHtml(file.extractionStatus || '未解析')}</td>
      <td>${escapeHtml(file.textPreview || file.extractionError || `约 ${file.wordCount || 0} 字符`)}</td>
    </tr>
  `).join('')
}

function isLongTextBlock(opinion = {}) {
  const textSegments = [
    opinion.conclusion,
    opinion.focus,
    ...(opinion.findings || []),
    ...(opinion.suggestions || []),
    ...(opinion.ruleMatches || []).map(rule => `${rule.name || ''}${rule.message || ''}`),
    ...(opinion.knowledgeHits || []).flatMap(hit => [
      hit.title,
      hit.content,
      ...(hit.matchedKeywords || []),
      ...(hit.evidence || []).flatMap(evidence => [evidence.sourceLabel, evidence.snippet]),
    ]),
  ]

  const contentLength = textSegments.join('').length
  const blockCount =
    (opinion.findings || []).length +
    (opinion.suggestions || []).length +
    (opinion.ruleMatches || []).length +
    (opinion.knowledgeHits || []).length

  return contentLength >= 1200 || blockCount >= 12
}

function buildOpinionSections(opinions = []) {
  if (!opinions.length) return '<p class="empty">无专业审核意见</p>'

  return opinions.map(opinion => `
    <section class="opinion-card ${isLongTextBlock(opinion) ? 'opinion-card-split' : ''}">
      <div class="section-subhead">
        <div>
          <div class="section-code">${escapeHtml(opinion.code)} · ${escapeHtml(opinion.hermesName || '')}</div>
          <h3>${escapeHtml(opinion.name)}</h3>
        </div>
        <div class="opinion-metrics">
          ${badge(`${opinion.score} 分`, 'cyan')}
          ${badge(`${opinion.risk}风险`, opinion.risk === '高' ? 'red' : opinion.risk === '中' ? 'amber' : 'emerald')}
        </div>
      </div>

      <table class="compact-table">
        <tr>
          <th>审核结论</th>
          <td>${safeText(opinion.conclusion)}</td>
          <th>审核焦点</th>
          <td>${safeText(opinion.focus)}</td>
        </tr>
      </table>

      <div class="two-column">
        <div>
          <div class="mini-title">规则校验</div>
          ${list((opinion.ruleMatches || []).map(rule => `${rule.name}：${rule.passed ? '通过' : '需补强'}${rule.impact ? `，扣分 ${rule.impact}` : ''}。${rule.message || ''}`))}
        </div>
        <div>
          <div class="mini-title">审核发现</div>
          ${list(opinion.findings || [])}
        </div>
      </div>

      <div class="single-block">
        <div class="mini-title">整改建议</div>
        ${list(opinion.suggestions || [])}
      </div>

      <div class="single-block">
        <div class="mini-title">命中专业知识条款</div>
        ${buildKnowledgeHitCards(opinion.knowledgeHits || [])}
      </div>
    </section>
  `).join('')
}

function buildSummaryRuleRows(items = []) {
  if (!items.length) {
    return `
      <tr>
        <td colspan="4" class="empty-cell">无启用规则记录</td>
      </tr>
    `
  }

  return items.map((rule, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(rule.name)}</td>
      <td>${rule.passed ? '通过' : '需补强'}</td>
      <td>${escapeHtml(rule.message || '')}</td>
    </tr>
  `).join('')
}

function buildTimelineRows(items = []) {
  if (!items.length) {
    return `
      <tr>
        <td colspan="4" class="empty-cell">无审核时间线</td>
      </tr>
    `
  }

  return items.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(row.action || '')}</td>
      <td>${escapeHtml(row.actor || '')}</td>
      <td>${escapeHtml(`${row.at || ''}${row.detail ? ` · ${row.detail}` : ''}`)}</td>
    </tr>
  `).join('')
}

function buildManualReviewSection(review = {}) {
  const basis = Array.isArray(review.basis) ? review.basis : []
  const actions = Array.isArray(review.actions) ? review.actions : []
  const hasContent = Boolean(
    review.conclusion ||
    review.summary ||
    basis.length > 0 ||
    actions.length > 0
  )

  if (!hasContent) return '<p class="empty">无结构化人工复核结论</p>'

  return `
    <table class="compact-table">
      <tr>
        <th>人工结论</th>
        <td>${safeText(review.conclusion)}</td>
        <th>复核人</th>
        <td>${safeText(review.reviewer)}</td>
      </tr>
      <tr>
        <th>复核时间</th>
        <td>${safeText(review.reviewedAt)}</td>
        <th>后续动作数</th>
        <td>${safeText(actions.length, '0')}</td>
      </tr>
    </table>
    <div class="single-block">
      <div class="mini-title">复核依据</div>
      ${list(basis, '无复核依据')}
    </div>
    <div class="single-block">
      <div class="mini-title">后续动作</div>
      ${list(actions, '无后续动作')}
    </div>
    <div class="single-block">
      <div class="mini-title">复核摘要</div>
      <p>${safeText(review.summary)}</p>
    </div>
  `
}

function buildExecutionRecordSection(record = {}) {
  const signOff = record.signOff || {}
  const archive = record.archive || {}

  return `
    <div class="two-column">
      <div>
        <div class="mini-title">签发记录</div>
        <table class="compact-table">
          <tr><th>签发状态</th><td>${safeText(signOff.status)}</td><th>签发人</th><td>${safeText(signOff.signer)}</td></tr>
          <tr><th>签发时间</th><td>${safeText(signOff.signedAt)}</td><th>签发文号</th><td>${safeText(signOff.documentCode)}</td></tr>
        </table>
        <div class="single-block">
          <div class="mini-title">签发说明</div>
          <p>${safeText(signOff.comment)}</p>
        </div>
      </div>
      <div>
        <div class="mini-title">归档记录</div>
        <table class="compact-table">
          <tr><th>归档状态</th><td>${safeText(archive.status)}</td><th>归档人</th><td>${safeText(archive.archivist)}</td></tr>
          <tr><th>归档时间</th><td>${safeText(archive.archivedAt)}</td><th>归档编号</th><td>${safeText(archive.archiveCode)}</td></tr>
          <tr><th>归档位置</th><td colspan="3">${safeText(archive.location)}</td></tr>
        </table>
        <div class="single-block">
          <div class="mini-title">归档说明</div>
          <p>${safeText(archive.comment)}</p>
        </div>
      </div>
    </div>
  `
}

function buildReminderSection(reminders = []) {
  if (!reminders.length) return '<p class="empty">无催办记录</p>'

  return reminders.map((row, index) => `
    <div class="evidence-item">
      <div class="evidence-meta">第 ${index + 1} 次 · ${escapeHtml(row.stage || '进度确认')} · ${escapeHtml(row.channel || '企业微信')} · ${escapeHtml(row.source === 'auto' ? '自动催办' : '人工登记')} · ${escapeHtml(row.remindedBy || '未记录')} · ${escapeHtml(row.remindedAt || '未记录')}</div>
      <div class="evidence-snippet">${escapeHtml(row.note || '无催办内容')}</div>
    </div>
  `).join('')
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(blob)
  })
}

const logoDataUrlCache = new Map()

async function resolveLogoDataUrl(logoUrl = '') {
  const normalizedUrl = String(logoUrl || '').trim()
  if (!normalizedUrl) return ''
  if (!logoDataUrlCache.has(normalizedUrl)) {
    logoDataUrlCache.set(
      normalizedUrl,
      fetch(normalizedUrl)
        .then(res => {
          if (!res.ok) throw new Error(`Logo 加载失败 (${res.status})`)
          return res.blob()
        })
        .then(readBlobAsDataUrl)
        .catch(() => '')
    )
  }
  return logoDataUrlCache.get(normalizedUrl)
}

function currentExportTime() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function buildDocumentCode(item, exportAtText) {
  const typeCode = item.type === '市场拓展方案' ? 'MT' : 'NY'
  const digits = String(item.id || '')
    .replace(/\D/g, '')
    .slice(-6)
    .padStart(6, '0')
  const dateCode = exportAtText.slice(0, 10).replaceAll('-', '')
  return `FS-HERMES-${typeCode}-${dateCode}-${digits}`
}

export function buildReviewReportHtml(item, options = {}) {
  const summary = item.summary || {}
  const report = item.initiationReport
  const opinions = item.opinions || []
  const manualReview = item.manualReview || {}
  const executionRecord = item.executionRecord || {}
  const reminders = item.reminders || []
  const notes = item.reviewNotes || []
  const timeline = item.timeline || []
  const files = item.files || []
  const summaryKnowledgeHits = summary.knowledgeHits || []
  const isMarketProposal = item.type === '市场拓展方案'
  const appVersion = options.appVersion || 'v0.0.1'
  const exportAt = options.exportedAt || currentExportTime()
  const documentCode = options.documentCode || buildDocumentCode(item, exportAt)
  const logoDataUrl = options.logoDataUrl || ''

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(item.title)}审核意见书</title>
  <style>
    body {
      font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      color: #111827;
      line-height: 1.75;
      font-size: 12pt;
      margin: 28px;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    @page {
      size: A4;
      margin: 24mm 16mm 20mm;
    }
    h1, h2, h3, p { margin: 0; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr, td, th {
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .doc-topline {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10pt;
      color: #6b7280;
      margin-bottom: 12px;
    }
    .page-title {
      text-align: center;
      margin-bottom: 10px;
    }
    .doc-logo-wrap {
      text-align: center;
      margin-bottom: 10px;
    }
    .doc-logo {
      max-width: 168px;
      max-height: 68px;
      object-fit: contain;
    }
    .page-title .company {
      font-size: 13pt;
      color: #4b5563;
      letter-spacing: 1px;
    }
    .page-title .title {
      margin-top: 8px;
      font-size: 24pt;
      font-weight: 700;
      letter-spacing: 1px;
    }
    .page-title .subtitle {
      margin-top: 10px;
      color: #6b7280;
      font-size: 10.5pt;
    }
    .section {
      margin-top: 20px;
      page-break-inside: auto;
      break-inside: auto;
    }
    .section-page-break {
      page-break-before: always;
      break-before: page;
    }
    .section-head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      padding-bottom: 6px;
      border-bottom: 1.5px solid #d1d5db;
      page-break-after: avoid;
      break-after: avoid;
    }
    .section-head .index {
      font-size: 10pt;
      color: #2563eb;
      font-weight: 700;
      letter-spacing: 0.6px;
    }
    .section-head h2 {
      font-size: 15pt;
      font-weight: 700;
    }
    .summary-callout {
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      padding: 14px 16px;
      margin-top: 14px;
    }
    .summary-callout .result {
      font-size: 16pt;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .meta-table, .compact-table, .plain-table {
      width: 100%;
      border-collapse: collapse;
      page-break-inside: auto;
      break-inside: auto;
    }
    .doc-meta-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .doc-meta-table td {
      border: 1px solid #d1d5db;
      padding: 8px 10px;
      font-size: 10.5pt;
    }
    .doc-meta-table td.label {
      width: 110px;
      background: #f3f4f6;
      font-weight: 700;
    }
    .meta-table th, .meta-table td,
    .compact-table th, .compact-table td,
    .plain-table th, .plain-table td {
      border: 1px solid #d1d5db;
      padding: 8px 10px;
      vertical-align: top;
    }
    .meta-table th, .compact-table th, .plain-table th {
      background: #f3f4f6;
      width: 120px;
      font-weight: 700;
      text-align: left;
    }
    .plain-table th:first-child, .plain-table td:first-child {
      width: 54px;
      text-align: center;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      margin-right: 6px;
      margin-bottom: 6px;
      border-radius: 999px;
      font-size: 9.5pt;
      border: 1px solid transparent;
    }
    .badge-blue { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
    .badge-emerald { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
    .badge-cyan { background: #ecfeff; border-color: #a5f3fc; color: #0f766e; }
    .badge-amber { background: #fffbeb; border-color: #fde68a; color: #b45309; }
    .badge-red { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
    .lead {
      margin-top: 8px;
      color: #374151;
    }
    .empty {
      color: #6b7280;
    }
    .empty-cell {
      text-align: center;
      color: #6b7280;
    }
    ul {
      margin: 8px 0 0 18px;
      padding: 0;
    }
    li { margin-bottom: 4px; }
    .two-column {
      display: table;
      width: 100%;
      table-layout: fixed;
      border-spacing: 0 10px;
      margin-top: 10px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .two-column > div {
      display: table-cell;
      width: 50%;
      vertical-align: top;
      padding-right: 16px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .mini-title {
      font-weight: 700;
      margin-bottom: 6px;
      color: #1f2937;
    }
    .single-block {
      margin-top: 12px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .opinion-card {
      margin-top: 14px;
      padding: 14px;
      border: 1px solid #d1d5db;
      background: #ffffff;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .opinion-card-split {
      page-break-inside: auto;
      break-inside: auto;
    }
    .opinion-card-split .compact-table,
    .opinion-card-split .two-column,
    .opinion-card-split .single-block,
    .opinion-card-split .hit-card,
    .opinion-card-split .evidence-item {
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .section-subhead {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 10px;
      page-break-after: avoid;
      break-after: avoid;
    }
    .section-subhead h3 {
      font-size: 13pt;
      font-weight: 700;
    }
    .section-code {
      font-size: 10pt;
      color: #6b7280;
      margin-bottom: 4px;
    }
    .opinion-metrics {
      text-align: right;
    }
    .hit-card {
      margin-top: 10px;
      border: 1px solid #d1d5db;
      background: #f9fafb;
      padding: 10px 12px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .hit-head {
      margin-bottom: 6px;
    }
    .hit-tags {
      margin-bottom: 4px;
    }
    .hit-title {
      font-weight: 700;
      color: #111827;
    }
    .hit-content {
      color: #374151;
    }
    .keyword-row {
      margin-top: 8px;
    }
    .keyword {
      display: inline-block;
      padding: 2px 8px;
      margin-right: 6px;
      margin-bottom: 6px;
      border-radius: 999px;
      font-size: 9pt;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1d4ed8;
    }
    .evidence-list {
      margin-top: 8px;
    }
    .evidence-item {
      margin-top: 8px;
      padding: 8px 10px;
      background: #ffffff;
      border-left: 3px solid #93c5fd;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .evidence-meta {
      font-size: 9pt;
      color: #6b7280;
    }
    .evidence-snippet {
      margin-top: 4px;
      color: #374151;
    }
    .signature-page {
      min-height: 220mm;
    }
    .signature-note {
      margin-top: 4px;
      color: #6b7280;
      font-size: 10pt;
    }
    .sign-table td {
      border: none;
      padding: 14px 0 0;
      vertical-align: bottom;
    }
    .sign-line {
      display: inline-block;
      min-width: 160px;
      border-bottom: 1px solid #9ca3af;
      height: 22px;
      vertical-align: bottom;
      margin-left: 8px;
    }
    .sign-seal-box {
      display: inline-block;
      width: 156px;
      height: 88px;
      border: 1px dashed #9ca3af;
      vertical-align: middle;
      margin-left: 8px;
    }
    .doc-footer {
      margin-top: 26px;
      padding-top: 10px;
      border-top: 1px solid #d1d5db;
      color: #6b7280;
      font-size: 9.5pt;
      display: flex;
      justify-content: space-between;
      gap: 16px;
    }
    @media print {
      .section,
      .summary-callout,
      .single-block,
      .hit-card,
      .evidence-item,
      .sign-table,
      .sign-table tr,
      .doc-footer {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .signature-page {
        page-break-before: always;
        break-before: page;
      }
    }
  </style>
</head>
<body>
  <div class="doc-topline">
    <div>文号：${escapeHtml(documentCode)}</div>
    <div>导出时间：${escapeHtml(exportAt)}</div>
  </div>

  ${logoDataUrl ? `
    <div class="doc-logo-wrap">
      <img class="doc-logo" src="${logoDataUrl}" alt="第一服务" />
    </div>
  ` : ''}

  <div class="page-title">
    <div class="company">第一服务研发小组审核系统</div>
    <div class="title">${isMarketProposal ? '市场拓展方案审核意见书' : '内部运营方案审核意见书'}</div>
    <div class="subtitle">根据公司作业标准及 AI 并行审核结果自动生成</div>
  </div>

  <table class="doc-meta-table">
    <tr>
      <td class="label">系统版本</td>
      <td>${escapeHtml(appVersion)}</td>
      <td class="label">导出类型</td>
      <td>${isMarketProposal ? '市场拓展正式意见书' : '内部运营正式意见书'}</td>
    </tr>
  </table>

  <div class="summary-callout">
    <div class="result">${escapeHtml(summary.result || '待审核')}</div>
    <div>${safeText(summary.finalOpinion, '暂无汇总意见')}</div>
  </div>

  <section class="section">
    <div class="section-head">
      <div class="index">01</div>
      <h2>方案基本信息</h2>
    </div>
    <table class="meta-table">
      <tr><th>方案名称</th><td colspan="3">${safeText(item.title)}</td></tr>
      <tr><th>方案类型</th><td>${safeText(item.type)}</td><th>审核机制</th><td>${safeText(item.robot)}</td></tr>
      <tr><th>提交人</th><td>${safeText(item.submitter)}</td><th>提交时间</th><td>${safeText(item.createdAt)}</td></tr>
      <tr><th>当前状态</th><td>${safeText(item.status)}</td><th>生成时间</th><td>${safeText(summary.generatedAt)}</td></tr>
      <tr><th>综合评分</th><td>${safeText(summary.avgScore, '-')}</td><th>高风险数量</th><td>${safeText(summary.riskCount?.high ?? 0, '0')}</td></tr>
      <tr><th>命中条款</th><td>${safeText(summary.knowledgeHitCount ?? 0, '0')}</td><th>附件数量</th><td>${safeText(files.length, '0')}</td></tr>
    </table>
    <p class="lead">${safeText(item.description, '暂无方案说明')}</p>
  </section>

  <section class="section">
    <div class="section-head">
      <div class="index">02</div>
      <h2>审核流程与附件摘要</h2>
    </div>
    <div class="two-column">
      <div>
        <div class="mini-title">审核流程</div>
        ${list(item.flow || [], '无流程记录')}
      </div>
      <div>
        <div class="mini-title">主要风险摘要</div>
        ${list(summary.mainRisks || [], '当前无重点风险摘要')}
      </div>
    </div>
    <div class="single-block">
      <div class="mini-title">附件解析摘要</div>
      <table class="plain-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>附件名称</th>
            <th>解析状态</th>
            <th>摘要</th>
          </tr>
        </thead>
        <tbody>
          ${buildAttachmentRows(files)}
        </tbody>
      </table>
    </div>
  </section>

  ${report ? `
    <section class="section">
      <div class="section-head">
        <div class="index">03</div>
        <h2>投资发展立项报告</h2>
      </div>
      <table class="compact-table">
        <tr><th>报告名称</th><td>${safeText(report.title)}</td><th>责任专业</th><td>${safeText(report.owner)}</td></tr>
        <tr><th>立项判断</th><td>${safeText(report.viability)}</td><th>生成时间</th><td>${safeText(report.generatedAt)}</td></tr>
      </table>
      <p class="lead">${safeText(report.summary)}</p>
      <div class="two-column">
        <div>
          <div class="mini-title">关键判断</div>
          ${list(report.keyPoints || [])}
        </div>
        <div>
          <div class="mini-title">立项风险</div>
          ${list(report.risks || [])}
        </div>
      </div>
      <div class="single-block">
        <div class="mini-title">命中投资发展知识条款</div>
        ${buildKnowledgeHitCards(report.knowledgeHits || [])}
      </div>
    </section>
  ` : ''}

  <section class="section">
    <div class="section-head">
      <div class="index">${report ? '04' : '03'}</div>
      <h2>专业审核意见</h2>
    </div>
    ${buildOpinionSections(opinions)}
  </section>

  <section class="section">
    <div class="section-head">
      <div class="index">${report ? '05' : '04'}</div>
      <h2>汇总结论与命中依据</h2>
    </div>
    <table class="compact-table">
      <tr><th>最终结论</th><td>${safeText(summary.result)}</td><th>综合评分</th><td>${safeText(summary.avgScore, '-')}</td></tr>
      <tr><th>规则补强项</th><td>${safeText(summary.failedRuleCount ?? 0, '0')}</td><th>命中知识条款</th><td>${safeText(summary.knowledgeHitCount ?? 0, '0')}</td></tr>
    </table>
    <div class="single-block">
      <div class="mini-title">汇总意见</div>
      <p>${safeText(summary.finalOpinion)}</p>
    </div>
    <div class="single-block">
      <div class="mini-title">命中知识条款</div>
      ${buildKnowledgeHitCards(summaryKnowledgeHits, true)}
    </div>
    <div class="single-block">
      <div class="mini-title">启用规则校验</div>
      <table class="plain-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>规则名称</th>
            <th>结果</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          ${buildSummaryRuleRows(summary.ruleMatches || [])}
        </tbody>
      </table>
    </div>
  </section>

  <section class="section">
    <div class="section-head">
      <div class="index">${report ? '06' : '05'}</div>
      <h2>人工复核与审核轨迹</h2>
    </div>
    <div class="two-column">
      <div>
        <div class="mini-title">人工复核结论</div>
        ${buildManualReviewSection(manualReview)}
      </div>
      <div>
        <div class="mini-title">人工复核备注</div>
        ${notes.length ? notes.map(note => `
          <div class="evidence-item">
            <div class="evidence-meta">${escapeHtml(note.actor)} · ${escapeHtml(note.at)}</div>
            <div class="evidence-snippet">${escapeHtml(note.content)}</div>
          </div>
        `).join('') : '<p class="empty">无人工复核备注</p>'}
      </div>
    </div>
    <div class="single-block">
      <div class="mini-title">审核时间线</div>
      <table class="plain-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>动作</th>
            <th>操作人</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          ${buildTimelineRows(timeline)}
        </tbody>
      </table>
    </div>
    <div class="single-block">
      <div class="mini-title">催办记录</div>
      ${buildReminderSection(reminders)}
    </div>
  </section>

  <section class="section section-page-break signature-page">
    <div class="section-head">
      <div class="index">${report ? '07' : '06'}</div>
      <h2>签发与归档记录</h2>
    </div>
    ${buildExecutionRecordSection(executionRecord)}
  </section>

  <section class="section section-page-break signature-page">
    <div class="section-head">
      <div class="index">${report ? '08' : '07'}</div>
      <h2>签发栏</h2>
    </div>
    <p class="signature-note">本页用于线下签字、盖章及归档，建议单独保留签章页。</p>
    <table class="sign-table">
      <tr>
        <td>审核结论确认：<span class="sign-line"></span></td>
        <td>签发人：<span class="sign-line"></span></td>
      </tr>
      <tr>
        <td>复核意见：<span class="sign-line"></span></td>
        <td>日期：<span class="sign-line"></span></td>
      </tr>
      <tr>
        <td>部门盖章：<span class="sign-seal-box"></span></td>
        <td>归档编号：<span class="sign-line"></span></td>
      </tr>
    </table>
  </section>

  <div class="doc-footer">
    <div>第一服务研发小组审核系统 · ${escapeHtml(appVersion)}</div>
    <div>${escapeHtml(documentCode)}</div>
    <div>本文件可直接打印或转存 PDF 留档</div>
  </div>
</body>
</html>`
}

async function buildReviewReportDocument(item, options = {}) {
  const logoDataUrl = options.logoDataUrl || await resolveLogoDataUrl(options.logoUrl)
  return buildReviewReportHtml(item, { ...options, logoDataUrl })
}

export async function previewReviewReport(item, options = {}) {
  return buildReviewReportDocument(item, options)
}

export async function downloadReviewReport(item, options = {}) {
  const html = await buildReviewReportDocument(item, options)
  const blob = new Blob([html], { type: 'application/msword;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${item.title || '方案'}审核意见书.doc`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export async function printReviewReportPdf(item, options = {}) {
  const html = await buildReviewReportDocument(item, options)
  const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=1080,height=820')
  if (!printWindow) throw new Error('浏览器拦截了打印窗口，请允许弹窗后重试')

  printWindow.document.open()
  printWindow.document.write(html)
  printWindow.document.close()

  const triggerPrint = () => {
    printWindow.focus()
    printWindow.print()
  }

  if (printWindow.document.readyState === 'complete') {
    setTimeout(triggerPrint, 180)
  } else {
    printWindow.addEventListener('load', () => setTimeout(triggerPrint, 180), { once: true })
  }

  printWindow.onafterprint = () => {
    setTimeout(() => printWindow.close(), 240)
  }
}
