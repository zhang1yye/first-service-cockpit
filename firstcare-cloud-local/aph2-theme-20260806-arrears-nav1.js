(() => {
  'use strict'

  const OPEN_TABS_KEY = 'aph-open-tabs-v1'
  const nativeFetch = window.fetch.bind(window)
  const nativeXhrOpen = window.XMLHttpRequest?.prototype.open
  let serviceCenterDirectoryPromise = null

  function normalizeServiceCenterKey(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .replace(/[·•・]/g, '')
      .replace(/^第一(?:服务|酒店)/, '')
      .replace(/(?:服务中心|体验中心)$/, '')
  }

  function buildServiceCenterDirectory(rows) {
    const entries = (Array.isArray(rows) ? rows : [])
      .map(row => ({
        area: String(row?.area || '').trim(),
        center: String(row?.center || '').trim(),
        key: normalizeServiceCenterKey(row?.center),
      }))
      .filter(entry => entry.center && entry.key)

    return entries
  }

  function findServiceCenterEntry(value, area, directory) {
    const current = String(value || '').trim()
    const key = normalizeServiceCenterKey(current)
    if (!current || !key) return null

    const candidates = directory.filter(entry => (
      (!area || !entry.area || entry.area === area)
      && (
        entry.key === key
        || entry.key.endsWith(key)
        || key.endsWith(entry.key)
      )
    ))
    if (candidates.length === 1) return candidates[0]

    const preferredType = current.endsWith('体验中心')
      ? candidates.filter(entry => entry.center.endsWith('体验中心'))
      : candidates.filter(entry => (
        entry.center.endsWith('服务中心')
        && !entry.center.endsWith('体验中心')
      ))
    return preferredType.length === 1 ? preferredType[0] : null
  }

  function resolveServiceCenterName(value, area, directory) {
    return findServiceCenterEntry(value, area, directory)?.center || String(value || '').trim()
  }

  function replaceServiceCenterNamesInText(value, area, directory) {
    let result = String(value || '')
    const candidates = directory
      .filter(entry => !area || !entry.area || entry.area === area)
    const aliases = candidates.flatMap(entry => {
      const withoutCity = entry.key.replace(
        /^(?:北京|天津|石家庄|张家口|葫芦岛|营口|保定|廊坊|青岛)/,
        '',
      )
      return [entry.key, withoutCity]
        .filter(alias => alias.length >= 5)
        .map(alias => ({ alias, entry }))
    }).filter(candidate => (
      aliasesForName(candidates, candidate.alias).length === 1
    )).sort((left, right) => right.alias.length - left.alias.length)

    const preserved = []
    candidates.forEach(entry => {
      if (!result.includes(entry.center)) return
      const placeholder = `__APH_CENTER_${preserved.length}__`
      preserved.push(entry.center)
      result = result.replaceAll(entry.center, placeholder)
    })
    const aliasMap = new Map(aliases.map(({ alias, entry }) => [alias, entry.center]))
    const pattern = new RegExp(
      aliases.map(({ alias }) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'g',
    )
    if (aliases.length) result = result.replace(pattern, match => aliasMap.get(match) || match)
    preserved.forEach((center, index) => {
      result = result.replaceAll(`__APH_CENTER_${index}__`, center)
    })
    return result
  }

  function aliasesForName(entries, alias) {
    return entries.filter(entry => {
      const withoutCity = entry.key.replace(
        /^(?:北京|天津|石家庄|张家口|葫芦岛|营口|保定|廊坊|青岛)/,
        '',
      )
      return entry.key === alias || withoutCity === alias
    })
  }

  function normalizeServiceCenterPayload(payload, pathname, directory) {
    const normalizeValue = (value, inheritedArea = '') => {
      if (Array.isArray(value)) return value.map(item => normalizeValue(item, inheritedArea))
      if (!value || typeof value !== 'object') return value

      const area = String(value.area || value.region || inheritedArea || '')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (key === 'center' || key === 'project_name' || key === 'projectName') {
          return [key, resolveServiceCenterName(item, area, directory)]
        }
        if (
          key === 'name'
          && (
            pathname.startsWith('/api/projects')
            || pathname.startsWith('/api/alerts')
            || pathname.startsWith('/api/tasks')
            || pathname.startsWith('/api/ai/')
          )
        ) {
          return [key, resolveServiceCenterName(item, area, directory)]
        }
        if (
          typeof item === 'string'
          && ['summary', 'text', 'answer', 'message'].includes(key)
        ) {
          return [key, replaceServiceCenterNamesInText(item, area, directory)]
        }
        return [key, normalizeValue(item, area)]
      }))
    }

    return enforceRealServiceCenterScope(
      normalizeValue(payload),
      pathname,
      directory,
    )
  }

  function filterRealServiceCenterRecords(records, fields, directory) {
    if (!Array.isArray(records)) return []
    return records.flatMap(record => {
      if (!record || typeof record !== 'object') return []
      const field = fields.find(key => typeof record[key] === 'string' && record[key].trim())
      if (!field) return []
      const area = String(record.area || record.region || '')
      const entry = findServiceCenterEntry(record[field], area, directory)
      if (!entry) return []
      return [{ ...record, [field]: entry.center }]
    })
  }

  function redactUnmatchedNames(value, unmatchedNames) {
    if (Array.isArray(value)) {
      return value.map(item => redactUnmatchedNames(item, unmatchedNames))
    }
    if (!value || typeof value !== 'object') {
      if (typeof value !== 'string') return value
      return unmatchedNames.reduce(
        (text, name) => text.replaceAll(name, '未匹配财务主数据项目（已隐藏）'),
        value,
      )
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactUnmatchedNames(item, unmatchedNames),
      ]),
    )
  }

  function enforceRealServiceCenterScope(payload, pathname, directory) {
    if (!payload || typeof payload !== 'object') return payload

    if (pathname === '/api/projects') {
      return {
        ...payload,
        rows: filterRealServiceCenterRecords(payload.rows, ['name'], directory),
        realServiceCenterOnly: true,
      }
    }

    if (pathname === '/api/alerts') {
      const sourceRows = payload.alerts || payload.rows || []
      const rows = filterRealServiceCenterRecords(
        sourceRows,
        ['project_name', 'name'],
        directory,
      )
      const high = rows.filter(item => item.severity === 'high').length
      const summary = payload.provisionalLevel
        ? payload.summary
        : rows.length
          ? `当前共有${rows.length}个已匹配财务主数据的服务中心触发预警，其中高风险${high}个。重点关注${rows.slice(0, 3).map(item => item.project_name || item.name).join('、')}。`
          : '当前没有已匹配财务主数据的服务中心触发预警。'
      return {
        ...payload,
        alerts: rows,
        rows,
        total: rows.length,
        summary,
        realServiceCenterOnly: true,
      }
    }

    if (pathname === '/api/ai/monthly-report') {
      const sourceAlerts = Array.isArray(payload.alerts) ? payload.alerts : []
      const sourceWeakest = Array.isArray(payload.weakestProjects) ? payload.weakestProjects : []
      const sourceNames = [...sourceAlerts, ...sourceWeakest]
        .map(item => item?.name)
        .filter(Boolean)
      const unmatchedNames = sourceNames.filter(name => (
        !findServiceCenterEntry(name, '', directory)
      ))
      const scoped = {
        ...payload,
        alerts: filterRealServiceCenterRecords(sourceAlerts, ['name'], directory),
        weakestProjects: filterRealServiceCenterRecords(sourceWeakest, ['name'], directory),
        realServiceCenterOnly: true,
      }
      return redactUnmatchedNames(scoped, unmatchedNames)
    }

    if (pathname === '/api/forecasts') {
      const rows = filterRealServiceCenterRecords(
        payload.rows,
        ['project_name'],
        directory,
      )
      const workflow = {
        draft: 0,
        submitted: 0,
        area_approved: 0,
        region_approved: 0,
        locked: 0,
        rejected: 0,
      }
      rows.forEach(row => {
        if (row.workflow_status in workflow) workflow[row.workflow_status] += 1
      })
      return {
        ...payload,
        rows,
        workflow,
        discipline: payload.discipline
          ? {
            ...payload.discipline,
            readyToSubmit: Math.min(payload.discipline.readyToSubmit || 0, rows.length),
            unready: Math.min(payload.discipline.unready || 0, rows.length),
          }
          : payload.discipline,
        realServiceCenterOnly: true,
      }
    }

    if (pathname === '/api/remediation-impact') {
      return {
        ...payload,
        rows: filterRealServiceCenterRecords(payload.rows, ['projectName'], directory),
        realServiceCenterOnly: true,
      }
    }

    if (pathname === '/api/tasks') {
      const rows = Array.isArray(payload.rows)
        ? payload.rows.filter(item => (
          !item?.project_name
          || Boolean(findServiceCenterEntry(item.project_name, item.area || '', directory))
        )).map(item => (
          item?.project_name
            ? {
              ...item,
              project_name: resolveServiceCenterName(
                item.project_name,
                item.area || '',
                directory,
              ),
            }
            : item
        ))
        : payload.rows
      return { ...payload, rows, realServiceCenterOnly: true }
    }

    if (
      pathname === '/api/ai/health'
      || pathname === '/api/ai/trends'
      || pathname === '/api/ai/risk-trends'
    ) {
      const result = { ...payload, realServiceCenterOnly: true }
      for (const key of ['projects', 'rows', 'alerts']) {
        if (!Array.isArray(result[key])) continue
        result[key] = filterRealServiceCenterRecords(
          result[key],
          ['project_name', 'name'],
          directory,
        )
      }
      return result
    }

    return payload
  }

  function loadServiceCenterDirectory(headers) {
    if (!serviceCenterDirectoryPromise) {
      serviceCenterDirectoryPromise = nativeFetch('/api/payments', { headers })
        .then(response => {
          if (!response.ok) throw new Error(`服务中心标准名称接口返回 ${response.status}`)
          return response.json()
        })
        .then(buildServiceCenterDirectory)
        .catch(error => {
          serviceCenterDirectoryPromise = null
          throw error
        })
    }
    return serviceCenterDirectoryPromise
  }

  function applyServiceCenterNamesToDom(pathname) {
    if (pathname !== '/daily' || !serviceCenterDirectoryPromise) return
    serviceCenterDirectoryPromise.then(directory => {
      document.querySelectorAll('main tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td')
        if (cells.length < 2) return
        const current = (cells[0].textContent || '').trim()
        const area = (cells[1].textContent || '').trim()
        const resolved = resolveServiceCenterName(current, area, directory)
        if (resolved && resolved !== current) cells[0].textContent = resolved
      })
    }).catch(() => {})
  }

  function applyCollectionAnnualTargetsToDom(pathname) {
    if (pathname !== '/collection') return
    document.querySelectorAll('.aph-collection-target').forEach(target => target.remove())
    exactTextElements(document.querySelector('main') || document, '华北综合收缴率').forEach(label => {
      const container = label.parentElement
      if (!container || container.querySelector('.aph-collection-target')) return
      const badge = document.createElement('span')
      badge.className = 'aph-collection-target'
      badge.textContent = '华北地区2026年度考核指标 88.39%'
      container.appendChild(badge)
      container.title = '华北地区2026年度收缴率考核指标：88.39%'
    })
  }

  function hideCollectionAgingColumns(pathname) {
    if (pathname !== '/collection') return
    const main = document.getElementById('main-content') || document

    exactTextElements(main, '按服务中心展开 · 含逾期账龄').forEach(element => {
      element.textContent = '按服务中心展开'
    })

    main.querySelectorAll('table').forEach(table => {
      const headers = Array.from(table.querySelectorAll('thead th'))
      const hiddenIndexes = headers.flatMap((header, index) => {
        const label = (header.textContent || '').replace(/\s+/g, '')
        return ['30天内逾期', '90天以上'].includes(label) ? [index] : []
      })
      if (!hiddenIndexes.length) return

      table.querySelectorAll('tr').forEach(row => {
        let effectiveIndex = 0
        Array.from(row.children).forEach(cell => {
          const span = Math.max(Number(cell.colSpan) || 1, 1)
          const cellIndexes = Array.from({ length: span }, (_, offset) => effectiveIndex + offset)
          effectiveIndex += span
          if (!cellIndexes.some(index => hiddenIndexes.includes(index))) return
          cell.hidden = true
          cell.setAttribute('aria-hidden', 'true')
          cell.style.setProperty('display', 'none', 'important')
        })
      })
      table.dataset.aphAgingColumnsHidden = '30天内逾期,90天以上'
    })
  }

  function enhanceCollectionFiltersAndSorting(pathname) {
    if (pathname !== '/collection') return
    const main = document.querySelector('main')
    if (!main) return

    Array.from(main.querySelectorAll('button')).filter(button => (
      (button.textContent || '').trim() === '已撤场项目'
    )).forEach(button => {
      button.classList.add('aph-withdrawn-filter')
      button.title = '查看已撤场项目'
      button.setAttribute('aria-label', '已撤场项目')
    })

  }

  function exactTextElements(root, text) {
    return Array.from(root.querySelectorAll('*')).filter(element => (
      (element.textContent || '').trim() === text
      && !Array.from(element.children).some(child => (
        (child.textContent || '').trim() === text
      ))
    ))
  }

  function replaceMetricValue(root, label, value) {
    exactTextElements(root, label).forEach(labelElement => {
      const container = labelElement.parentElement
      if (!container) return
      const valueElement = Array.from(container.children).find(element => (
        element !== labelElement
        && (
          element.classList.contains('num')
          || /\d|%|万|m²/.test((element.textContent || '').trim())
        )
      ))
      if (valueElement) {
        valueElement.textContent = value
        valueElement.classList.add('aph-data-unavailable')
      }
    })
  }

  function replaceLiveMetricValue(root, label, value) {
    exactTextElements(root, label).forEach(labelElement => {
      const container = labelElement.parentElement
      if (!container) return
      const valueElement = Array.from(container.children).find(element => (
        element !== labelElement
        && (
          element.classList.contains('num')
          || /\d|%|万/.test((element.textContent || '').trim())
        )
      ))
      if (valueElement && valueElement.textContent !== value) {
        valueElement.textContent = value
        valueElement.classList.remove('aph-data-unavailable')
      }
    })
  }

  function formatWan(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return '—'
    return `${number.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}万`
  }

  function applyLvzaiSummaryToDom(root, pathname) {
    if (!root || !['/', '/collection'].includes(pathname)) return
    const summary = window.__aphLvzaiSummary
    if (!summary) return
    if (pathname === '/collection') {
      const areaFilter = root.querySelector('select')
      if (areaFilter && areaFilter.value !== '全部') return
      const receivable = Number(summary.collectionReceivable)
      const received = Number(summary.collectionReceived)
      const rate = Number(summary.collectionRate)
      replaceLiveMetricValue(root, '应收总额', formatWan(receivable))
      replaceLiveMetricValue(root, '实收总额', formatWan(received))
      replaceLiveMetricValue(root, '未收金额', formatWan(Math.max(receivable - received, 0)))
      replaceLiveMetricValue(
        root,
        '华北综合收缴率',
        Number.isFinite(rate) ? `${(rate * 100).toFixed(2)}%` : '—',
      )
      return
    }
    const card = root.querySelector('a[href="/collection"]')
    if (!card) return
    replaceLiveMetricValue(card, '应收总额', formatWan(summary.collectionReceivable))
    replaceLiveMetricValue(card, '实收总额', formatWan(summary.collectionReceived))
    card.dataset.aphCollectionSource = summary.collectionSource || '绿仔管家'
    card.title = '绿仔实时接口；新风类、物业类、供暖类，不含供暖补贴；排除葫芦岛两个政府项目、中信珺台、葫芦岛首创·象墅；万国城、满庭、青云供暖费按当年11月至次年3月修正'
  }

  function applyHomeCollectionAnnualTarget(root, pathname) {
    if (!root || pathname !== '/') return
    const card = root.querySelector('a[href="/collection"]')
    if (!card) return

    const annualTarget = 0.8839
    const currentRate = Number(window.__aphLvzaiSummary?.collectionRate)
    if (!Number.isFinite(currentRate)) return

    const ring = Array.from(card.querySelectorAll('div')).find(element => (
      element.classList.contains('relative')
      && element.querySelector('svg[viewBox="0 0 140 140"]')
    ))
    if (!ring) return

    const status = Array.from(ring.querySelectorAll('div')).find(element => {
      if (element.children.length !== 0) return false
      const text = (element.textContent || '').trim()
      return text === '已达标' || text.startsWith('差 ')
    })
    if (!status) return

    const gap = annualTarget - currentRate
    status.textContent = gap > 0.00005
      ? `差 ${(gap * 100).toFixed(2)}%`
      : '已达标'
    status.dataset.aphAnnualTarget = '88.39%'
    status.title = `华北全年收缴率指标88.39%，当前${(currentRate * 100).toFixed(2)}%`
    card.dataset.aphCollectionAnnualTarget = '88.39%'
  }

  function replaceSummaryCard(root, label, value, description) {
    exactTextElements(root, label).forEach(labelElement => {
      const card = labelElement.parentElement
      if (!card) return
      const numberElement = card.querySelector('.num')
      if (numberElement) {
        numberElement.textContent = value
        numberElement.classList.add('aph-data-unavailable')
      }
      const descriptionElement = Array.from(card.children).find(element => (
        element !== labelElement
        && element !== numberElement
        && !element.classList.contains('num')
      ))
      if (descriptionElement && description) {
        descriptionElement.textContent = description
      }
    })
  }

  function projectEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character])
  }

  function projectFormatNumber(value, digits = 0) {
    if (value === null || value === undefined || value === '') return '—'
    const number = Number(value)
    return Number.isFinite(number) ? number.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—'
  }

  function projectFormatWan(value) {
    if (value === null || value === undefined || value === '') return '—'
    const number = Number(value)
    return Number.isFinite(number) ? `${projectFormatNumber(number, 2)}万` : '—'
  }

  function projectFormatArea(value) {
    if (value === null || value === undefined || value === '') return '—'
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? `${projectFormatNumber(number / 10000, 2)}万㎡` : '—'
  }

  function projectFormatCount(value) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? projectFormatNumber(number) : '—'
  }

  function projectFormatDate(value) {
    if (!value) return '—'
    const match = String(value).match(/^\d{4}-\d{2}-\d{2}/)
    return match ? match[0] : String(value)
  }

  function projectFormatMetric(value, suffix) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? `${projectFormatNumber(number, 2).replace(/\.00$/, '')}${suffix}` : '—'
  }

  function projectFormatRate(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '—'
  }

  function projectAuthHeaders() {
    const token = window.localStorage.getItem('cockpit_token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  async function projectProfileRequest(pathname) {
    const response = await nativeFetch(pathname, { headers: projectAuthHeaders() })
    if (!response.ok) throw new Error(response.status === 403 ? '当前账号无权查看项目档案' : `数据请求失败（${response.status}）`)
    return response.json()
  }

  function projectLinkBadge(operating) {
    const status = operating?.linkStatus || 'unmatched'
    const copy = status === 'linked' ? '已关联' : status === 'linked_multi' ? '多中心关联' : status === 'partial' ? '部分关联' : '未匹配'
    return `<span class="aph-project-link aph-project-link-${projectEscape(status)}">${copy}</span>`
  }

  function projectRowsHtml(rows) {
    if (!rows.length) return '<tr><td colspan="9"><div class="aph-project-empty">当前筛选条件下没有项目档案</div></td></tr>'
    return rows.map(row => `
      <tr data-project-profile-id="${Number(row.id)}" tabindex="0" aria-label="查看${projectEscape(row.service_center)}档案">
        <td>${projectEscape(row.area || '未归片区')}</td>
        <td><strong>${projectEscape(row.service_center)}</strong><small>${projectEscape(row.city || '')}${row.address ? ` · ${projectEscape(row.address)}` : ''}</small></td>
        <td class="num">${projectFormatNumber(row.phase_count)}</td>
        <td>${projectEscape(row.property_type || '未填写')}</td>
        <td class="num">${projectFormatArea(row.managed_area)}</td>
        <td class="num">${projectFormatCount(row.movedin_units)}</td>
        <td class="num">${projectFormatWan(row.operating?.payment?.cumulativeExecuted)}</td>
        <td class="num">${projectFormatRate(row.operating?.collection?.collectionRate)}</td>
        <td>${projectLinkBadge(row.operating)}</td>
      </tr>`).join('')
  }

  function projectDetailField(label, value) {
    return `<div><dt>${projectEscape(label)}</dt><dd>${value === null || value === undefined || value === '' ? '—' : projectEscape(value)}</dd></div>`
  }

  async function openProjectProfileDetail(page, profileId) {
    const drawer = page.querySelector('.aph-project-drawer')
    const panel = drawer?.querySelector('.aph-project-drawer-panel')
    if (!drawer || !panel) return
    drawer.hidden = false
    drawer.setAttribute('aria-busy', 'true')
    panel.innerHTML = '<div class="aph-project-detail-loading">正在读取项目档案…</div>'
    try {
      const detail = await projectProfileRequest(`/api/project-profiles/${profileId}`)
      const profile = detail.profile
      const operating = profile.operating || {}
      panel.innerHTML = `
        <header class="aph-project-detail-head">
          <div><span>${projectEscape(profile.area || '未归片区')} · 在管</span><h2>${projectEscape(profile.service_center)}</h2><p>${projectEscape(profile.city || '')}${profile.address ? ` · ${projectEscape(profile.address)}` : ''}</p></div>
          <button type="button" data-project-drawer-close aria-label="关闭项目档案">×</button>
        </header>
        <section class="aph-project-detail-operating">
          <div><span>累计回款</span><strong>${projectFormatWan(operating.payment?.cumulativeExecuted)}</strong><small>APH回款额执行评估</small></div>
          <div><span>年度预算完成率</span><strong>${projectFormatRate(operating.payment?.annualExecutionRate)}</strong><small>累计执行/年度预算</small></div>
          <div><span>官方收缴率</span><strong>${projectFormatRate(operating.collection?.collectionRate)}</strong><small>${operating.collection?.officialRateSource ? '绿仔官方项目率加权' : '尚无绿仔官方率'}</small></div>
          <div><span>经营关联</span><strong>${projectLinkBadge(operating)}</strong><small>${projectEscape([...(operating.paymentCenters || []), ...(operating.collectionCenters || [])].filter((value, index, array) => array.indexOf(value) === index).join('、') || '暂无对应经营中心')}</small></div>
        </section>
        <section class="aph-project-detail-section"><h3>基础档案</h3><dl class="aph-project-detail-grid">
          ${projectDetailField('物业业态', profile.property_type)}${projectDetailField('服务类型', profile.service_type)}
          ${projectDetailField('项目来源', profile.project_source)}${projectDetailField('客户类型', profile.client_type)}
          ${projectDetailField('在管面积', projectFormatArea(profile.managed_area))}${projectDetailField('待交付面积', projectFormatArea(profile.pending_area))}
          ${projectDetailField('签约户数', projectFormatCount(profile.signed_units))}${projectDetailField('已入伙户数', projectFormatCount(profile.movedin_units))}
          ${projectDetailField('运营主体', profile.company_entity)}${projectDetailField('数据源行', (profile.sourceRows || []).join('、'))}
        </dl></section>
        <section class="aph-project-detail-section"><h3>在管分期（${projectFormatNumber(detail.phases.length)}）</h3>
          <div class="aph-project-phase-list">${detail.phases.map(phase => `
            <article><div><strong>${projectEscape(phase.phaseName)}</strong><span>在管</span></div><dl>
              ${projectDetailField('实际入伙', projectFormatDate(phase.actual_movein))}${projectDetailField('在管面积', projectFormatArea(phase.managed_area))}
              ${projectDetailField('已入伙户数', projectFormatCount(phase.movedin_units))}${projectDetailField('住宅物业费', phase.residential_fee === null ? '—' : `${projectFormatNumber(phase.residential_fee, 2)}元/㎡·月`)}
              ${projectDetailField('合同期限', `${projectFormatDate(phase.contract_start)} 至 ${projectFormatDate(phase.contract_end)}`)}${projectDetailField('收费模式', phase.charging_model)}
              ${projectDetailField('合同备案', phase.contract_filed)}${projectDetailField('业委会情况', phase.committee)}
              ${projectDetailField('地上车位', projectFormatMetric(phase.ground_parking, '个'))}${projectDetailField('地下车位', projectFormatMetric(phase.underground_parking, '个'))}
              ${projectDetailField('物业用房', [phase.management_room_location, projectFormatMetric(phase.management_room_area, '㎡')].filter(value => value && value !== '—').join(' · '))}${projectDetailField('公共收益核算', phase.public_revenue_accounting)}
              ${projectDetailField('出入口', projectFormatMetric(phase.entrances, '个'))}${projectDetailField('监控摄像头', projectFormatMetric(phase.cameras, '个'))}
              ${projectDetailField('客梯', projectFormatMetric(phase.passenger_elevators, '部'))}${projectDetailField('货梯', projectFormatMetric(phase.freight_elevators, '部'))}
            </dl></article>`).join('')}</div>
        </section>`
      panel.querySelector('[data-project-drawer-close]')?.addEventListener('click', () => { drawer.hidden = true })
    } catch (error) {
      panel.innerHTML = `<div class="aph-project-error"><strong>项目档案读取失败</strong><span>${projectEscape(error?.message || error)}</span><button type="button" data-project-drawer-close>关闭</button></div>`
      panel.querySelector('[data-project-drawer-close]')?.addEventListener('click', () => { drawer.hidden = true })
    } finally {
      drawer.removeAttribute('aria-busy')
    }
  }

  async function renderProjectProfilesPage(main, pathname) {
    if (pathname !== '/projects' || !main || main.dataset.aphProjectProfiles) return
    main.dataset.aphProjectProfiles = 'loading'
    try {
      const [summary, list] = await Promise.all([
        projectProfileRequest('/api/project-profiles/summary'),
        projectProfileRequest('/api/project-profiles'),
      ])
      const totals = summary.totals || {}
      const rows = Array.isArray(list.rows) ? list.rows : []
      const officialCount = rows.filter(row => row.operating?.collection?.collectionRate !== null && row.operating?.collection?.collectionRate !== undefined).length
      const page = document.createElement('section')
      page.className = 'aph-project-profile-page'
      page.innerHTML = `
        <header class="aph-project-page-head">
          <div><span>华北项目主数据 · 只读</span><h1>项目档案与经营数据</h1><p>当前仅纳入管理状态为“在管”的项目分期；档案来自项目基础信息汇编，回款来自APH，收缴率来自绿仔官方项目率。</p></div>
          <div class="aph-project-source"><strong>${projectEscape(summary.batch?.sourceFile || '项目基础信息汇编')}</strong><span>${projectFormatNumber(totals.profiles)}个服务中心 · ${projectFormatNumber(totals.phases)}个在管分期</span></div>
        </header>
        <section class="aph-project-kpis" aria-label="项目经营概览">
          <article><span>在管服务中心</span><strong class="num">${projectFormatNumber(totals.profiles)}</strong><small>项目主档</small></article>
          <article><span>在管项目分期</span><strong class="num">${projectFormatNumber(totals.phases)}</strong><small>不含合约、撤场</small></article>
          <article><span>在管面积</span><strong class="num">${projectFormatArea(totals.managed_area)}</strong><small>主数据汇总</small></article>
          <article><span>已入伙户数</span><strong class="num">${projectFormatNumber(totals.movedin_units)}</strong><small>主数据汇总</small></article>
          <article><span>经营数据已关联</span><strong class="num">${projectFormatNumber(totals.linked_profiles)} / ${projectFormatNumber(totals.profiles)}</strong><small>易水名苑暂未匹配</small></article>
          <article><span>累计回款</span><strong class="num">${projectFormatWan(totals.cumulative_executed)}</strong><small>已关联APH中心</small></article>
          <article><span>项目官方收缴率</span><strong class="num">${projectFormatRate(totals.collection_rate)}</strong><small>${officialCount}个有官方率项目，应收加权</small></article>
        </section>
        <section class="aph-project-table-card">
          <div class="aph-project-toolbar">
            <div><h2>在管项目档案</h2><span data-project-visible-count>${projectFormatNumber(rows.length)}个服务中心</span></div>
            <label><span>片区</span><select data-project-filter="area" aria-label="片区筛选"><option value="">全部片区</option>${(summary.areas || []).map(item => `<option value="${projectEscape(item.area)}">${projectEscape(item.area)}（${item.profiles}）</option>`).join('')}</select></label>
            <label><span>业态</span><select data-project-filter="property"><option value="">全部业态</option>${(summary.propertyTypes || []).map(item => `<option value="${projectEscape(item.property_type)}">${projectEscape(item.property_type || '未填写')}（${item.profiles}）</option>`).join('')}</select></label>
            <label class="aph-project-search"><span>搜索</span><input data-project-filter="q" type="search" placeholder="服务中心、城市或地址" aria-label="搜索项目档案"></label>
          </div>
          <div class="aph-project-table-wrap" tabindex="0" aria-label="项目档案表格，可横向滚动">
            <table><thead><tr><th>片区</th><th>服务中心</th><th>分期</th><th>业态</th><th>在管面积</th><th>已入伙</th><th>累计回款</th><th>官方收缴率</th><th>经营关联</th></tr></thead><tbody>${projectRowsHtml(rows)}</tbody></table>
          </div>
          <p class="aph-project-footnote">官方收缴率使用绿仔项目字段按项目应收加权；“—”表示尚无对应事实数据，不以0替代。点击任一服务中心查看分期、合同和设施档案。</p>
        </section>
        <div class="aph-project-drawer" hidden><button class="aph-project-drawer-mask" type="button" data-project-drawer-close aria-label="关闭项目档案"></button><aside class="aph-project-drawer-panel" aria-label="项目档案详情"></aside></div>`
      main.replaceChildren(page)
      main.dataset.aphProjectProfiles = 'ready'
      const area = page.querySelector('[data-project-filter="area"]')
      const property = page.querySelector('[data-project-filter="property"]')
      const query = page.querySelector('[data-project-filter="q"]')
      const tbody = page.querySelector('tbody')
      const count = page.querySelector('[data-project-visible-count]')
      const filter = () => {
        const q = String(query?.value || '').trim().toLowerCase()
        const visible = rows.filter(row => (!area?.value || row.area === area.value)
          && (!property?.value || row.property_type === property.value)
          && (!q || `${row.service_center} ${row.city} ${row.address}`.toLowerCase().includes(q)))
        if (tbody) tbody.innerHTML = projectRowsHtml(visible)
        if (count) count.textContent = `${visible.length}个服务中心`
      }
      area?.addEventListener('change', filter)
      property?.addEventListener('change', filter)
      query?.addEventListener('input', filter)
      page.addEventListener('click', event => {
        if (event.target.closest('[data-project-drawer-close]')) {
          const drawer = page.querySelector('.aph-project-drawer')
          if (drawer) drawer.hidden = true
          return
        }
        const row = event.target.closest('[data-project-profile-id]')
        if (row) openProjectProfileDetail(page, Number(row.dataset.projectProfileId))
      })
      page.addEventListener('keydown', event => {
        const row = event.target.closest('[data-project-profile-id]')
        if (row && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          openProjectProfileDetail(page, Number(row.dataset.projectProfileId))
        }
      })
    } catch (error) {
      main.dataset.aphProjectProfiles = 'error'
      const message = document.createElement('section')
      message.className = 'aph-project-error'
      message.innerHTML = `<strong>项目档案暂时无法读取</strong><span>${projectEscape(error?.message || error)}</span><button type="button">重新加载</button>`
      message.querySelector('button')?.addEventListener('click', () => { delete main.dataset.aphProjectProfiles; renderProjectProfilesPage(main, pathname) })
      main.replaceChildren(message)
    }
  }

  function applyRealDataAvailability(root, pathname) {
    if (!root) return

    if (pathname === '/projects') {
      replaceMetricValue(root, '管理面积', '数据暂未接入')
      replaceMetricValue(root, '总户数', '数据暂未接入')
      replaceMetricValue(root, '累计收入', '数据暂未接入')
      replaceMetricValue(root, '健康分', '暂未接入')
      replaceMetricValue(root, '利润率', '暂未接入')
      replaceSummaryCard(root, '低收费率', '—', '仅对有应收口径的服务中心计算')
      replaceSummaryCard(root, '利润承压', '—', '收入成本接口暂未接入')
      replaceSummaryCard(root, '高风险预警', '—', '正式分级规则尚未配置')

      root.querySelectorAll('*').forEach(element => {
        const text = (element.textContent || '').trim()
        if (
          element.children.length === 0
          && text.startsWith('关注原因：')
        ) {
          element.textContent = '关注原因：依据真实回款差额列示，其他经营维度暂未接入'
        }
        if (
          element.children.length === 0
          && text === '今日判断：重点跟进'
        ) {
          element.textContent = '今日判断：数据待核实'
        }
        if (
          element.children.length === 0
          && text === '真实数据可用 · 日常经营跟踪 · 管理闭环沉淀'
        ) {
          element.textContent = '真实财务数据 · 缺失维度已明确标注 · 只读展示'
        }
        if (
          element.children.length === 0
          && text.includes('按健康分、收费率、利润率、安全与投诉综合排序')
        ) {
          element.textContent = '按真实回款差额列示；健康分、利润率、安全与投诉接口接入后再参与排序。'
        }
        if (element.children.length === 0 && text === '0分') {
          element.textContent = '健康分暂未接入'
          element.classList.add('aph-data-unavailable')
        }
        if (element.children.length === 0 && text === '0.0%') {
          element.textContent = '暂不可用'
          element.classList.add('aph-data-unavailable')
        }
      })
    }

    if (pathname === '/ai-report') {
      replaceMetricValue(root, '累计收入', '数据暂未接入')
      replaceMetricValue(root, '利润率', '数据暂未接入')
      replaceMetricValue(root, '品质均分', '数据暂未接入')
      replaceMetricValue(root, '满意度', '数据暂未接入')
      root.querySelectorAll('button').forEach(button => {
        const text = (button.textContent || '').trim()
        if (
          [
            '归档当前月报',
            '导出Word正式月报',
            '刷新草稿基线',
            '生成正式月报',
            '生成最近周会纪要',
          ].includes(text)
        ) {
          button.disabled = true
          button.title = '真实归档或正式输出接口暂未接入'
          button.classList.add('aph-action-unavailable')
        }
      })
      root.querySelectorAll('*').forEach(element => {
        if (element.children.length !== 0) return
        const text = (element.textContent || '').trim()
        if (text === '0.0%') {
          element.textContent = '暂不可用'
          element.classList.add('aph-data-unavailable')
        } else if (
          text.includes('利润率0.0%，整体经营状态需要重点跟进')
        ) {
          element.textContent = text.replace(
            '利润率0.0%，整体经营状态需要重点跟进',
            '利润率暂未接入；当前结论仅基于真实回款与收缴数据',
          )
        } else if (
          text.includes('风险主要集中在收费率、利润率、投诉和安全管理')
        ) {
          element.textContent = text.replace(
            '风险主要集中在收费率、利润率、投诉和安全管理',
            '当前仅依据真实累计回款差额列示，正式风险分级规则尚未配置',
          )
        } else if (
          text.includes('建议以低收费率项目为主线建立周度催缴清单')
        ) {
          element.textContent = '建议先核对累计预算与实际回款差额；利润、品质、安全和投诉接口接入后，再形成跨维度管理动作。'
        } else if (
          text === '项目经营数据来自导入的真实项目经营表，系统按当前数据生成经营分析和月报。'
        ) {
          element.textContent = '服务中心范围由当前账号权限及回款、收缴接口返回；未接入指标已明确标注。'
        } else if (
          text === 'AI预警基于收费率、利润率、品质、安全事故、满意度、投诉量等阈值规则。'
        ) {
          element.textContent = '当前预警仅列示真实累计回款差额；红、橙、黄正式规则尚未配置。'
        } else if (
          text.startsWith('同比/环比优先使用项目月度快照')
        ) {
          element.textContent = '真实月度快照接口暂未接入，当前不生成同比、环比和风险趋势结论。'
        } else if (text === '低收费率跟进清单') {
          element.textContent = '收缴口径待核实清单'
        }
      })
    }

    if (pathname === '/collection') {
      exactTextElements(root, '历史收缴趋势').forEach(labelElement => {
        const container = labelElement.closest('section') || labelElement.parentElement
        if (!container || container.querySelector('.aph-trend-unavailable')) return
        const note = document.createElement('p')
        note.className = 'aph-trend-unavailable'
        note.textContent = '真实月度历史流水接口暂未接入，已停止展示演示趋势。'
        labelElement.parentElement?.append(note)
      })
    }
  }

  // 在数据进入各页面前统一名称，保证页面、下钻与导出使用同一套服务中心名称。
  if (nativeXhrOpen) {
    window.XMLHttpRequest.prototype.open = function openWithLocalApi(
      method,
      url,
      ...rest
    ) {
      const requestUrl = new URL(String(url), window.location.origin)
      const shouldUseLocalProxy = (
        requestUrl.hostname === 'www.firstcare.cloud'
        && (
          requestUrl.pathname.startsWith('/api/')
          || requestUrl.pathname.startsWith('/review-system/')
        )
      )
      const requestTarget = shouldUseLocalProxy
        ? `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`
        : url
      return nativeXhrOpen.call(this, method, requestTarget, ...rest)
    }
  }

  window.fetch = async (input, init = {}) => {
    const requestUrl = new URL(
      typeof input === 'string' ? input : input.url,
      window.location.origin,
    )
    const shouldUseLocalProxy = (
      requestUrl.hostname === 'www.firstcare.cloud'
      && (
        requestUrl.pathname.startsWith('/api/')
        || requestUrl.pathname.startsWith('/review-system/')
      )
    )
    const requestTarget = shouldUseLocalProxy
      ? `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`
      : input
    const response = await nativeFetch(requestTarget, init)
    const pathname = requestUrl.pathname
    if (response.ok && pathname === '/api/summary') {
      response.clone().json().then(summary => {
        if (
          summary
          && Number.isFinite(Number(summary.collectionRate))
          && Number.isFinite(Number(summary.collectionReceivable))
          && Number.isFinite(Number(summary.collectionReceived))
        ) {
          window.__aphLvzaiSummary = summary
          schedule()
        }
      }).catch(() => {})
    }
    if (response.ok && pathname === '/api/collections') {
      response.clone().json().then(payload => {
        const rows = Array.isArray(payload) ? payload : payload?.rows
        const summary = rows?.[0]?._lvzaiSummary
        if (summary) {
          window.__aphLvzaiSummary = summary
          schedule()
        }
      }).catch(() => {})
    }
    const shouldNormalize = (
      pathname.startsWith('/api/daily')
      || pathname.startsWith('/api/projects')
      || pathname.startsWith('/api/alerts')
      || pathname.startsWith('/api/tasks')
      || pathname.startsWith('/api/ai/')
      || pathname === '/api/forecasts'
      || pathname === '/api/remediation-impact'
    )
    if (!response.ok || !shouldNormalize) {
      if (response.ok && pathname === '/api/payments') {
        response.clone().json()
          .then(buildServiceCenterDirectory)
          .then(directory => {
            serviceCenterDirectoryPromise = Promise.resolve(directory)
          })
          .catch(() => {})
      }
      return response
    }

    try {
      const [payload, directory] = await Promise.all([
        response.clone().json(),
        loadServiceCenterDirectory(init.headers),
      ])
      const normalized = normalizeServiceCenterPayload(payload, pathname, directory)
      if (pathname === '/api/ai/monthly-report') {
        try {
          const projectsResponse = await nativeFetch('/api/projects', {
            headers: init.headers,
          })
          if (projectsResponse.ok) {
            const projectsPayload = await projectsResponse.json()
            const realProjects = filterRealServiceCenterRecords(
              projectsPayload.rows,
              ['name'],
              directory,
            )
            if (normalized.summary) {
              normalized.summary.project_count = realProjects.length
            }
          }
        } catch {
          // 项目主数据不可用时沿用接口原值，不生成替代数字。
        }
      }
      const headers = new Headers(response.headers)
      headers.set('content-type', 'application/json; charset=utf-8')
      headers.delete('content-length')
      return new Response(JSON.stringify(normalized), {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return response
    }
  }

  function navigateWithinApp(targetHref, sourceLink) {
    const targetUrl = new URL(targetHref, window.location.origin)
    if (targetUrl.origin !== window.location.origin) return
    const targetLocation = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
    const currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (targetLocation === currentLocation) return
    const nativeRouteLink = Array.from(document.querySelectorAll('a[href]')).find(candidate => {
      if (
        candidate === sourceLink
        || candidate.closest('.aph-exact-sidebar')
        || candidate.closest('.aph-page-tabs')
      ) return false
      const candidateUrl = new URL(candidate.href, window.location.origin)
      return `${candidateUrl.pathname}${candidateUrl.search}${candidateUrl.hash}` === targetLocation
    })
    if (nativeRouteLink) {
      nativeRouteLink.click()
      return
    }
    window.history.pushState(window.history.state, '', targetLocation)
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  }

  function readOpenTabs() {
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(OPEN_TABS_KEY) || '[]')
      if (!Array.isArray(stored)) return []
      return stored.filter(item => (
        item
        && typeof item.href === 'string'
        && item.href.startsWith('/')
        && typeof item.label === 'string'
      ))
    } catch {
      return []
    }
  }

  function writeOpenTabs(items) {
    const home = items.find(item => item.href === '/') || { href: '/', label: '首页' }
    const recent = items.filter(item => item.href !== '/').slice(-9)
    window.sessionStorage.setItem(OPEN_TABS_KEY, JSON.stringify([home, ...recent]))
  }

  function applyHomeDashboardLayout(main, path) {
    if (path !== '/' || !main) return
    const root = main.firstElementChild
    if (!root) return

    const sections = Array.from(root.children).filter(element => element.tagName === 'SECTION')
    const banner = sections.find(section => section.classList.contains('aph-business-banner'))
    const kpiGrid = sections.find(section => (
      section !== banner
      && (section.textContent || '').includes('核心指标')
      && (section.textContent || '').includes('累计执行')
    ))
    if (!banner || !kpiGrid) return

    root.classList.add('aph-home-reflow')
    banner.classList.add('aph-home-visual')
    kpiGrid.classList.add('aph-home-kpi-grid')

    const followingSections = sections.filter(section => section !== banner && section !== kpiGrid)
    followingSections[0]?.classList.add('aph-home-region-grid')
    followingSections[1]?.classList.add('aph-home-ranking-grid')
  }

  function enhanceHomeRegionMap(main, path) {
    if (path !== '/' || !main) return
    const map = main.querySelector('svg[aria-label="辽宁、河北、天津、北京区域地图"]')
    if (!map) return

    const groups = Array.from(map.querySelectorAll('g[tabindex="0"]'))
    const selectedRegion = String(window.__aphSelectedHomeRegion || '')
    const selectRegion = group => {
      const region = (group.querySelector('text')?.textContent || '').trim()
      window.__aphSelectedHomeRegion = region
      groups.forEach(item => {
        const selected = item === group
        item.toggleAttribute('data-aph-map-selected', selected)
        item.setAttribute('aria-pressed', String(selected))
      })
    }

    groups.forEach(group => {
      const region = (group.querySelector('text')?.textContent || '').trim()
      group.setAttribute('role', 'button')
      group.setAttribute('aria-label', `${region}，点击选中`)
      group.setAttribute('aria-pressed', String(region === selectedRegion))
      group.toggleAttribute('data-aph-map-selected', region === selectedRegion)
      if (group.dataset.aphMapBound === '1') return
      group.addEventListener('click', () => selectRegion(group))
      group.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        selectRegion(group)
      })
      group.dataset.aphMapBound = '1'
    })
  }

  function applyTheme() {
    if (!document.body) return
    const path = window.location.pathname
    applyServiceCenterNamesToDom(path)
    applyCollectionAnnualTargetsToDom(path)
    hideCollectionAgingColumns(path)
    enhanceCollectionFiltersAndSorting(path)
    document.body.classList.add('aph2-theme')
    document.body.classList.toggle('aph-review-page', path.startsWith('/review'))
    document.body.classList.toggle('aph-admin-page', path === '/admin')
    document.documentElement.style.colorScheme = 'light'

    const sidebar = document.querySelector('aside[aria-label*="导航栏"]')
    const sidebarLogo = sidebar?.querySelector('img[alt="第一服务"]')
    if (sidebarLogo && sidebarLogo.dataset.aphLogo !== '1') {
      sidebarLogo.src = '/aph-icons/aph-brand-lockup.jpg'
      sidebarLogo.alt = 'APH 2.0'
      sidebarLogo.dataset.aphLogo = '1'
    }
    sidebar?.querySelectorAll('nav a, nav button').forEach(item => {
      const label = (item.textContent || '').replace(/\s+/g, ' ').trim()
      if (!label) return
      item.title = label
      item.dataset.aphNavLabel = label
    })

    const exactNavItems = [
      { href: '/', label: '驾驶舱看板', icon: 'shouyeF.png' },
      { href: '/command', label: '经营工作台', icon: 'RectangleCopy.png' },
      { href: '/projects', label: '项目管理', icon: 'shangye.png' },
      { href: '/payment', label: '回款额执行', icon: 'caiwu.png' },
      { href: '/daily', label: '每日回款明细', icon: 'renliziyuan.png' },
      { href: '/collection', label: '收缴率明细', icon: 'fangchanwuye.png' },
      { href: '/arrears/', label: '欠费资源分析', icon: 'chengbentongjifenxi.png' },
      { href: '/ai-alerts', label: 'AI预警中心', icon: 'chengbentongjifenxi.png' },
      { href: '/ai-report', label: 'AI经营月报', icon: 'jiaoyu.png' },
      { href: '/review?view=workbench', label: '研发审核系统', icon: 'tiyukebu.png' },
      { href: '/admin', label: '系统管理', icon: 'jurassic_users.png' },
    ]
    const shellRoot = document.querySelector('#root > div')
    let exactSidebar = shellRoot?.querySelector('.aph-exact-sidebar')
    if (shellRoot && !exactSidebar) {
      exactSidebar = document.createElement('aside')
      exactSidebar.className = 'aph-exact-sidebar'
      exactSidebar.setAttribute('aria-label', 'APH 2.0 主导航')
      exactSidebar.innerHTML = `
        <nav class="aph-exact-sidebar-panel">
          ${exactNavItems.map(item => `
            <a href="${item.href}" title="${item.label}" data-aph-exact-href="${item.href}">
              <img src="/aph-icons/${item.icon}" alt="">
              <span>${item.label}</span>
            </a>`).join('')}
        </nav>`
      shellRoot.insertBefore(exactSidebar, sidebar)
    }
    exactSidebar?.querySelectorAll('a[data-aph-exact-href]').forEach(link => {
      const href = link.dataset.aphExactHref || '/'
      const [targetPath, targetQuery = ''] = href.split('?')
      const active = targetPath === '/'
        ? path === '/'
        : path === targetPath || path.startsWith(`${targetPath}/`)
      const queryMatches = !targetQuery || window.location.search.slice(1) === targetQuery
      if (active && queryMatches) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
      if (link.dataset.aphRouteBound !== '1') {
        link.addEventListener('click', event => {
          if (
            event.defaultPrevented
            || event.button !== 0
            || event.metaKey
            || event.ctrlKey
            || event.shiftKey
            || event.altKey
          ) return
          const targetUrl = new URL(link.href, window.location.origin)
          if (targetUrl.origin !== window.location.origin) return
          if (targetUrl.pathname.startsWith('/arrears/')) {
            event.preventDefault()
            event.stopImmediatePropagation()
            window.location.assign(targetUrl.href)
            return
          }
          event.preventDefault()
          navigateWithinApp(targetUrl.href, link)
        })
        link.dataset.aphRouteBound = '1'
      }
    })

    const main = document.getElementById('main-content')
    renderProjectProfilesPage(main, path)
    const realDataPages = ['/projects', '/ai-alerts', '/ai-report', '/collection']
    if (main && realDataPages.includes(path) && !main.querySelector('.aph-real-data-scope')) {
      const note = document.createElement('div')
      note.className = 'aph-real-data-scope'
      const noteCopy = path === '/collection'
        ? '当前页使用收缴现有接口；真实月度历史流水未接入，演示趋势已停用。'
        : path === '/projects'
          ? '项目档案展示账号权限范围内全部在管服务中心；经营指标仅对已建立显式映射的项目显示，缺失值以“—”标记。'
          : '当前仅展示账号权限范围内、已与回款和收缴主数据匹配的服务中心；缺失指标不再使用演示值或 0 代替。'
      note.innerHTML = `
        <strong>真实数据范围</strong>
        <span>${noteCopy}</span>
      `
      main.prepend(note)
    }
    applyRealDataAvailability(main, path)

    const header = document.querySelector('header.sticky')
      || (path === '/admin' ? document.querySelector('#root header') : null)
    if (header && !document.querySelector('.aph-top-brand')) {
      const brand = document.createElement('div')
      brand.className = 'aph-top-brand'
      brand.innerHTML = '<img src="/aph-icons/aph-brand-lockup.jpg" alt="APH 2.0">'
      document.body.append(brand)
    }

    if (header && !header.querySelector('.aph-header-menu')) {
      const menu = document.createElement('button')
      menu.type = 'button'
      menu.className = 'aph-header-menu'
      menu.setAttribute('aria-label', '锁定或取消锁定主导航')
      menu.setAttribute('aria-controls', 'aph-exact-sidebar-panel')
      menu.innerHTML = '<img src="/aph-icons/aph-menu-toggle.jpg" alt="" aria-hidden="true">'
      header.firstElementChild?.append(menu)
    }
    const menu = header?.querySelector('.aph-header-menu')
    const navPanel = exactSidebar?.querySelector('.aph-exact-sidebar-panel')
    if (navPanel) navPanel.id = 'aph-exact-sidebar-panel'
    if (exactSidebar && menu && menu.dataset.aphClickBound !== '1') {
      const savedExpanded = window.sessionStorage.getItem('aph-nav-pinned-v2') === '1'
      exactSidebar.classList.toggle('is-expanded', savedExpanded)
      menu.setAttribute('aria-expanded', String(savedExpanded))
      exactSidebar.addEventListener('mouseenter', () => {
        exactSidebar.classList.add('is-hovered')
        menu.setAttribute('aria-expanded', 'true')
      })
      exactSidebar.addEventListener('mouseleave', () => {
        exactSidebar.classList.remove('is-hovered')
        menu.setAttribute(
          'aria-expanded',
          String(exactSidebar.classList.contains('is-expanded')),
        )
      })
      menu.addEventListener('click', () => {
        const expanded = exactSidebar.classList.toggle('is-expanded')
        menu.setAttribute('aria-expanded', String(expanded))
        window.sessionStorage.setItem('aph-nav-pinned-v2', expanded ? '1' : '0')
      })
      menu.dataset.aphClickBound = '1'
    }

    const routeNames = {
      '/': '首页',
      '/command': '经营工作台',
      '/projects': '项目管理',
      '/payment': '回款额执行',
      '/collection': '收缴率明细',
      '/arrears/': '欠费资源分析',
      '/ai-alerts': 'AI预警中心',
      '/ai-report': 'AI经营月报',
      '/daily': '每日回款明细',
      '/review': '研发审核系统',
      '/admin': '系统管理',
    }
    const pageName = routeNames[path] || '华北运营智能驾驶舱'
    const currentHref = path === '/review' && window.location.search.includes('view=workbench')
      ? '/review?view=workbench'
      : path
    let tabs = document.querySelector('.aph-page-tabs')
    if (header && !tabs) {
      tabs = document.createElement('div')
      tabs.className = 'aph-page-tabs'
      tabs.innerHTML = `
        <div class="aph-tab-left">
          <span class="aph-tab-menu" aria-hidden="true"><img src="/aph-icons/aph-menu-toggle.jpg" alt=""></span>
          <a class="aph-tab-home" href="/" aria-label="返回首页"><img src="/aph-icons/aph-tab-prev.jpg" alt=""></a>
          <div class="aph-tab-list" role="tablist" aria-label="已打开页面"></div>
        </div>
        <div class="aph-tab-actions" aria-hidden="true">
          <img src="/aph-icons/aph-tab-prev.jpg" alt="">
        </div>`
      header.insertAdjacentElement('afterend', tabs)
    }
    const homeTab = tabs?.querySelector('.aph-tab-home')
    if (homeTab && homeTab.dataset.aphRouteBound !== '1') {
      homeTab.addEventListener('click', event => {
        if (
          event.defaultPrevented
          || event.button !== 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) return
        event.preventDefault()
        navigateWithinApp('/', homeTab)
      })
      homeTab.dataset.aphRouteBound = '1'
    }
    if (tabs) {
      let openTabs = readOpenTabs()
      if (!openTabs.some(item => item.href === '/')) {
        openTabs.unshift({ href: '/', label: routeNames['/'] })
      }
      const currentIndex = openTabs.findIndex(item => item.href === currentHref)
      if (currentIndex === -1) openTabs.push({ href: currentHref, label: pageName })
      else openTabs[currentIndex].label = pageName
      writeOpenTabs(openTabs)

      const tabList = tabs.querySelector('.aph-tab-list')
      const signature = JSON.stringify({ currentHref, openTabs })
      if (tabList && tabList.dataset.aphSignature !== signature) {
        tabList.replaceChildren(...openTabs.map(item => {
          const tab = document.createElement('span')
          tab.className = `aph-route-tab${item.href === currentHref ? ' is-active' : ''}`
          tab.setAttribute('role', 'presentation')

          const link = document.createElement('a')
          link.href = item.href
          link.dataset.aphTabHref = item.href
          link.setAttribute('role', 'tab')
          link.setAttribute('aria-selected', String(item.href === currentHref))
          if (item.href === currentHref) link.setAttribute('aria-current', 'page')
          link.textContent = item.label
          tab.append(link)

          if (item.href !== '/') {
            const close = document.createElement('button')
            close.type = 'button'
            close.className = 'aph-route-tab-close'
            close.dataset.aphCloseTab = item.href
            close.setAttribute('aria-label', `关闭${item.label}`)
            close.textContent = '×'
            tab.append(close)
          }
          return tab
        }))
        tabList.dataset.aphSignature = signature
        requestAnimationFrame(() => {
          tabList.querySelector('.aph-route-tab.is-active')?.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
          })
        })
      }

      if (tabList && tabList.dataset.aphEventsBound !== '1') {
        tabList.addEventListener('click', event => {
          const close = event.target.closest('[data-aph-close-tab]')
          if (close) {
            event.preventDefault()
            event.stopPropagation()
            const href = close.dataset.aphCloseTab
            const currentTabs = readOpenTabs()
            const closingIndex = currentTabs.findIndex(item => item.href === href)
            const isActive = href === (
              window.location.pathname === '/review' && window.location.search.includes('view=workbench')
                ? '/review?view=workbench'
                : window.location.pathname
            )
            const remaining = currentTabs.filter(item => item.href !== href)
            writeOpenTabs(remaining)
            if (isActive) {
              const fallback = remaining[Math.max(0, closingIndex - 1)] || remaining[0] || { href: '/' }
              navigateWithinApp(fallback.href, close)
            } else {
              applyTheme()
            }
            return
          }

          const link = event.target.closest('a[data-aph-tab-href]')
          if (!link || event.defaultPrevented || event.button !== 0) return
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          navigateWithinApp(link.dataset.aphTabHref, link)
        })
        tabList.dataset.aphEventsBound = '1'
      }
    }

    if (header && !header.querySelector('.aph-header-status')) {
      const status = document.createElement('div')
      status.className = 'aph-header-status'
      header.firstElementChild?.insertBefore(status, header.firstElementChild.lastElementChild)
    }
    const status = header?.querySelector('.aph-header-status')
    const sourceText = header?.textContent || ''
    const syncMatch = sourceText.match(/数据同步时间[：:]\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
    const lvzaiSyncMatch = String(
      window.__aphLvzaiSummary?.collectionExtractedAt || '',
    ).match(/^(\d{4})-(\d{2})-(\d{2})/)
    const syncDate = syncMatch
      ? `${syncMatch[1]} / ${syncMatch[2].padStart(2, '0')} / ${syncMatch[3].padStart(2, '0')}`
      : lvzaiSyncMatch
        ? `${lvzaiSyncMatch[1]} / ${lvzaiSyncMatch[2]} / ${lvzaiSyncMatch[3]}`
        : '—'
    const statusHtml = `华北年度经营冲刺&nbsp;&nbsp;·&nbsp;&nbsp;数据更新至 <b>${syncDate}</b>`
    if (status && status.innerHTML !== statusHtml) status.innerHTML = statusHtml

    if (path === '/' && main && !main.querySelector('.aph-business-banner')) {
      const host = main.firstElementChild || main
      const banner = document.createElement('section')
      banner.className = 'aph-business-banner'
      const date = new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date()).replaceAll('/', ' / ')
      banner.innerHTML = `
        <div class="aph-banner-brand"><img src="/logo.png" alt="第一服务"></div>
        <div class="aph-banner-copy">
          <p>NORTH CHINA OPERATION COMMAND</p>
          <h1>华北地区经营驾驶舱</h1>
          <h2>数据驱动 · 风险识别 · 经营提效</h2>
        </div>
        <time>${date}</time>`
      host.prepend(banner)
    }

    applyHomeDashboardLayout(main, path)
    enhanceHomeRegionMap(main, path)
    applyLvzaiSummaryToDom(main, path)
    applyHomeCollectionAnnualTarget(main, path)

    const titles = main?.querySelectorAll('h1, h2') || []
    titles.forEach(title => {
      if (title.closest('.aph-business-banner')) return
      const text = (title.textContent || '').trim()
      if (/华北.*(驾驶舱|指挥台)|经营驾驶舱/.test(text)) {
        const container = title.closest('article, section, div')
        if (container && container !== main) container.dataset.aphHero = '1'
      }
    })
  }

  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      applyTheme()
    })
  }

  if (document.body) applyTheme()
  else document.addEventListener('DOMContentLoaded', applyTheme, { once: true })

  const start = () => {
    if (!document.documentElement) return
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
  }
  if (document.documentElement) start()
  else document.addEventListener('readystatechange', start, { once: true })
})()
