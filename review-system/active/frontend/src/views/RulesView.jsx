import { useEffect, useId, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BookOpenCheck, Edit3, Plus, Power, Save, Trash2, X } from '../lib/lucide.js'
import { api } from '../lib/api'
import Panel from '../components/Panel'

const emptyForm = {
  category: '通用',
  name: '',
  status: '停用',
  weight: 10,
  description: ''
}

const defaultReminderForm = {
  highRiskReview: { enabled: true, warningHours: 12, overdueHours: 24 },
  manualReview: { enabled: true, warningHours: 24, overdueHours: 48 },
  signOff: { enabled: true, warningHours: 6, overdueHours: 12 },
  archive: { enabled: true, warningHours: 12, overdueHours: 24 },
  autoCreateEnabled: true,
  defaultChannel: '企业微信'
}

const reminderStageLabels = {
  highRiskReview: '高风险复核',
  manualReview: '人工复核',
  signOff: '签发',
  archive: '归档'
}

const reminderStageEntries = Object.entries(reminderStageLabels)

const formatReminderConfirm = (form = defaultReminderForm) => [
  `生成催办草稿：${form.autoCreateEnabled ? '允许' : '停用'}`,
  `默认渠道：${form.defaultChannel || '企业微信'}`,
  ...Object.entries(reminderStageLabels).map(([key, label]) => {
    const stage = form[key] || {}
    return `${label}：${stage.enabled ? '启用' : '停用'}，预警 ${Number(stage.warningHours) || 0} 小时，超时 ${Number(stage.overdueHours) || 0} 小时`
  })
].join('\n')

const ruleChangeLines = (beforeRule = {}, afterRule = {}) => {
  const fields = [
    ['name', '名称'],
    ['category', '类别'],
    ['status', '状态'],
    ['weight', '权重'],
    ['description', '说明']
  ]
  return fields
    .filter(([key]) => String(beforeRule[key] ?? '') !== String(afterRule[key] ?? ''))
    .map(([key, label]) => `${label}: ${beforeRule[key] ?? ''} -> ${afterRule[key] ?? ''}`)
}

export default function RulesView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [rules, setRules] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actingId, setActingId] = useState('')
  const [reminderForm, setReminderForm] = useState(defaultReminderForm)
  const [savingReminderConfig, setSavingReminderConfig] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const ruleNameInputId = useId()
  const ruleCategoryInputId = useId()
  const ruleStatusInputId = useId()
  const ruleWeightInputId = useId()
  const ruleDescriptionInputId = useId()
  const defaultChannelInputId = useId()
  const autoCreateEnabledInputId = useId()

  const loadRules = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.get('/rules')
      setRules(data.rules || [])
      setReminderForm(data.reminderConfig || defaultReminderForm)
    } catch (err) {
      setError(err.message || '规则加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadRules()
  }, [])

  const statusFilter = searchParams.get('status') || '全部'

  const filteredRules = useMemo(() => (
    rules.filter(rule => statusFilter === '全部' || rule.status === statusFilter)
  ), [rules, statusFilter])

  const updateForm = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const resetForm = () => {
    setForm(emptyForm)
    setEditingId('')
    setError('')
    setMessage('')
  }

  const editRule = (rule) => {
    setEditingId(rule.id)
    setForm({
      category: rule.category,
      name: rule.name,
      status: rule.status,
      weight: rule.weight,
      description: rule.description
    })
    setError('')
    setMessage('')
  }

  const saveRule = async (e) => {
    e.preventDefault()
    const payload = { ...form, weight: Number(form.weight) || 10 }
    const confirmText = '保存审核规则'
    if (editingId) {
      const currentRule = rules.find(rule => rule.id === editingId)
      const changes = ruleChangeLines(currentRule || {}, payload)
      const detailText = changes.length ? changes.join('\n') : '未检测到字段变化'
      if (changes.length > 0) {
        const typed = window.prompt(`保存规则《${currentRule?.name || payload.name}》会影响后续方案审核口径。\n${detailText}\n\n如确认保存，请输入：${confirmText}`)?.trim()
        if (typed !== confirmText) {
          setError(`规则保存已取消：需输入“${confirmText}”才会执行。`)
          return
        }
      }
    } else {
      const typed = window.prompt(`新增审核规则《${payload.name || '未命名规则'}》会影响后续方案审核口径。\n\n如确认新增，请输入：${confirmText}`)?.trim()
      if (typed !== confirmText) {
        setError(`规则新增已取消：需输入“${confirmText}”才会执行。`)
        return
      }
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      if (editingId) {
        const result = await api.patch(`/rules/${editingId}`, { ...payload, confirmText })
        setMessage((result.changeCount ?? 0) > 0 ? `规则修改成功，记录 ${result.changeCount} 项变更` : '规则未发生变化')
      } else {
        await api.post('/rules', { ...payload, confirmText })
        setMessage('规则新增成功')
      }
      resetForm()
      await loadRules()
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleRuleStatus = async (rule) => {
    const nextStatus = rule.status === '启用' ? '停用' : '启用'
    const confirmText = '切换规则状态'
    const typed = window.prompt(`确认${nextStatus}规则《${rule.name}》？\n该操作会影响后续方案审核的规则命中和评分口径。${nextStatus === '启用' ? '\n启用前必须核对已批准的业务口径；当前确认将作为本次启用留痕。' : ''}\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`规则状态更新已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingId(rule.id)
    setError('')
    setMessage('')
    try {
      await api.patch(`/rules/${rule.id}`, { status: nextStatus, confirmText, basisVerified: nextStatus === '启用' })
      setMessage(`规则已${nextStatus === '启用' ? '启用' : '停用'}`)
      await loadRules()
    } catch (err) {
      setError(err.message || '规则状态更新失败')
    } finally {
      setActingId('')
    }
  }

  const removeRule = async (rule) => {
    const confirmText = '删除规则'
    const typed = window.prompt(`删除规则《${rule.name}》后不可恢复，并会影响后续审核口径。\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`规则删除已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingId(rule.id)
    setError('')
    setMessage('')
    try {
      await api.delete(`/rules/${rule.id}`, { confirmText })
      if (editingId === rule.id) resetForm()
      setMessage('规则已删除')
      await loadRules()
    } catch (err) {
      setError(err.message || '规则删除失败')
    } finally {
      setActingId('')
    }
  }

  const updateReminderStage = (stageKey, field, value) => {
    setReminderForm(prev => ({
      ...prev,
      [stageKey]: {
        ...prev[stageKey],
        [field]: field === 'enabled' ? value : Number(value) || 0
      }
    }))
  }

  const saveReminderConfig = async () => {
    const confirmText = window.prompt(`保存催办草稿与超时规则会影响方案提醒、逾期判断和后续审核节奏。系统不会自动发送消息。\n${formatReminderConfirm(reminderForm)}\n\n如确认保存，请输入：保存催办规则`)?.trim()
    if (confirmText !== '保存催办规则') {
      setError('请输入“保存催办规则”后再保存催办规则')
      return
    }
    setSavingReminderConfig(true)
    setError('')
    setMessage('')
    try {
      const payload = {
        ...reminderForm,
        highRiskReview: {
          ...reminderForm.highRiskReview,
          warningHours: Number(reminderForm.highRiskReview.warningHours) || 12,
          overdueHours: Number(reminderForm.highRiskReview.overdueHours) || 24
        },
        manualReview: {
          ...reminderForm.manualReview,
          warningHours: Number(reminderForm.manualReview.warningHours) || 24,
          overdueHours: Number(reminderForm.manualReview.overdueHours) || 48
        },
        signOff: {
          ...reminderForm.signOff,
          warningHours: Number(reminderForm.signOff.warningHours) || 6,
          overdueHours: Number(reminderForm.signOff.overdueHours) || 12
        },
        archive: {
          ...reminderForm.archive,
          warningHours: Number(reminderForm.archive.warningHours) || 12,
          overdueHours: Number(reminderForm.archive.overdueHours) || 24
        }
      }
      const data = await api.patch('/reminder-config', { ...payload, confirmText })
      setReminderForm(data.reminderConfig || payload)
      setMessage('催办草稿与超时规则保存成功')
    } catch (err) {
      setError(err.message || '催办规则保存失败')
    } finally {
      setSavingReminderConfig(false)
    }
  }

  const enabledCount = rules.filter(rule => rule.status === '启用').length
  const disabledCount = rules.length - enabledCount
  const marketRuleCount = rules.filter(rule => rule.category === '市场拓展').length
  const ruleFilterSummary = `状态：${statusFilter}；当前显示 ${filteredRules.length} 条；总规则 ${rules.length} 条；启用 ${enabledCount} 条；停用 ${disabledCount} 条`
  const ruleSummary = (rule = {}) => `规则《${rule.name || '未命名规则'}》，类别 ${rule.category || '未记录'}，权重 ${rule.weight || 0}，状态 ${rule.status || '未知'}`
  const ruleStatusActionLabel = (rule = {}) => {
    const nextStatus = rule.status === '启用' ? '停用' : '启用'
    if (actingId === rule.id) return `正在${nextStatus}规则《${rule.name || '未命名规则'}》`
    return `${nextStatus}规则《${rule.name || '未命名规则'}》，执行前需要输入“切换规则状态”确认；该操作会影响后续方案审核的规则命中和评分口径`
  }
  const saveRuleLabel = saving
    ? `正在保存规则《${form.name || '未命名规则'}》`
    : `${editingId ? '保存' : '新增'}规则《${form.name || '未命名规则'}》，执行前需要输入“保存审核规则”确认；该操作会影响后续方案审核口径`
  const reminderSaveLabel = savingReminderConfig
    ? '正在保存催办规则'
    : `保存催办草稿与超时规则，执行前需要输入“保存催办规则”确认。${formatReminderConfirm(reminderForm).replaceAll('\n', '；')}`

  const setStatusFilter = (value) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === '全部') next.delete('status')
      else next.set('status', value)
      return next
    })
  }

  const StatusBadge = ({ status }) => (
    <span className={`px-2 py-1 rounded text-xs border ${
      status === '启用'
        ? 'text-emerald-300 bg-emerald-500/10 border-emerald-400/30'
        : 'text-slate-300 bg-slate-500/10 border-slate-400/30'
    }`}>
      {status}
    </span>
  )

  return (
    <div className="grid grid-cols-12 gap-4">
      <section className="col-span-12 xl:col-span-8 space-y-4">
        <Panel className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h1 className="text-xl font-bold text-blue-200 flex items-center gap-2">
                <BookOpenCheck size={21} aria-hidden="true" />
                规则配置
              </h1>
              <p className="text-sm text-slate-400 mt-1">维护审核模型使用的规则类别、权重、启停状态和说明。</p>
            </div>
            <button
              type="button"
              onClick={resetForm}
              title="切换到新增审核规则表单"
              aria-label="切换到新增审核规则表单"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-400/40 bg-blue-600/20 text-blue-100 text-sm"
            >
              <Plus size={16} aria-hidden="true" />
              新增规则
            </button>
          </div>

          <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-100">
            只有已批准并完成业务口径核验的规则才可启用。新增规则默认停用；测试模板和未审批规则不得参与评分或审核结论。
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <button
              type="button"
              onClick={() => setStatusFilter('启用')}
              title={`筛选启用规则，当前 ${enabledCount} 条；${ruleFilterSummary}`}
              aria-label={`筛选启用规则，当前 ${enabledCount} 条；${ruleFilterSummary}`}
              className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25"
            >
              <div className="text-xs text-slate-500">启用规则</div>
              <div className="mt-2 text-2xl font-bold text-emerald-200">{enabledCount}</div>
              <div className="mt-2 text-xs text-blue-300">点击筛选启用规则</div>
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('停用')}
              title={`筛选停用规则，当前 ${disabledCount} 条；${ruleFilterSummary}`}
              aria-label={`筛选停用规则，当前 ${disabledCount} 条；${ruleFilterSummary}`}
              className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25"
            >
              <div className="text-xs text-slate-500">停用规则</div>
              <div className="mt-2 text-2xl font-bold text-slate-200">{disabledCount}</div>
              <div className="mt-2 text-xs text-blue-300">点击筛选停用规则</div>
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('全部')}
              title={`恢复全部规则视图，市场拓展规则 ${marketRuleCount} 条；${ruleFilterSummary}`}
              aria-label={`恢复全部规则视图，市场拓展规则 ${marketRuleCount} 条；${ruleFilterSummary}`}
              className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25"
            >
              <div className="text-xs text-slate-500">市场拓展规则</div>
              <div className="mt-2 text-2xl font-bold text-cyan-200">{marketRuleCount}</div>
              <div className="mt-2 text-xs text-blue-300">点击恢复全部规则视图</div>
            </button>
          </div>

          {statusFilter !== '全部' && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3">
              <div className="text-sm text-slate-300">当前筛选：规则状态为“{statusFilter}”</div>
              <button
                type="button"
                onClick={() => setStatusFilter('全部')}
                title={`清除规则状态筛选，当前筛选：${ruleFilterSummary}`}
                aria-label={`清除规则状态筛选，当前筛选：${ruleFilterSummary}`}
                className="text-xs text-blue-300 hover:text-blue-200"
              >
                清除筛选
              </button>
            </div>
          )}

          {loading ? (
            <div className="text-center py-12 text-slate-400">加载中...</div>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                aria-label={`审核规则列表，当前显示 ${filteredRules.length} 条规则，筛选状态：${statusFilter}`}
              >
                <caption className="sr-only">
                  审核规则列表。当前显示 {filteredRules.length} 条规则，筛选状态：{statusFilter}。每行可修改、启用停用或删除规则。
                </caption>
                <thead className="text-slate-400 bg-slate-900/70">
                  <tr>
                    {['规则名称', '类别', '权重', '状态', '更新时间', '操作'].map(item => (
                      <th key={item} className="text-left py-2 px-3 font-medium whitespace-nowrap">{item}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRules.map(rule => (
                    <tr key={rule.id} className="border-b border-blue-500/10 hover:bg-blue-500/5">
                      <td className="px-3 py-2 min-w-[240px]">
                        <div className="font-medium text-blue-100">{rule.name}</div>
                        <div className="text-xs text-slate-400 line-clamp-2 mt-1">{rule.description}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{rule.category}</td>
                      <td className="px-3 py-2 text-cyan-200">{rule.weight}</td>
                      <td className="px-3 py-2"><StatusBadge status={rule.status} /></td>
                      <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{rule.updatedAt}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={() => editRule(rule)}
                            title={`修改${ruleSummary(rule)}`}
                            aria-label={`修改${ruleSummary(rule)}`}
                            className="inline-flex items-center gap-1 text-blue-300 hover:text-blue-200"
                          >
                            <Edit3 size={15} aria-hidden="true" />
                            修改
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleRuleStatus(rule)}
                            disabled={actingId === rule.id}
                            title={ruleStatusActionLabel(rule)}
                            aria-label={ruleStatusActionLabel(rule)}
                            className="inline-flex items-center gap-1 text-amber-300 hover:text-amber-200 disabled:opacity-50"
                          >
                            <Power size={15} aria-hidden="true" />
                            {rule.status === '启用' ? '停用' : '启用'}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeRule(rule)}
                            disabled={actingId === rule.id}
                            title={`删除${ruleSummary(rule)}，执行前需要输入“删除规则”确认；删除后不可恢复`}
                            aria-label={`删除${ruleSummary(rule)}，执行前需要输入“删除规则”确认；删除后不可恢复`}
                            className="inline-flex items-center gap-1 text-red-300 hover:text-red-200 disabled:opacity-50"
                          >
                            <Trash2 size={15} aria-hidden="true" />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>

      <aside className="col-span-12 xl:col-span-4 space-y-4">
        <Panel className="p-5">
          <h2 className="font-semibold text-blue-100 mb-4">{editingId ? '修改规则' : '新增规则'}</h2>
          <form onSubmit={saveRule} className="space-y-4">
            <label className="block" htmlFor={ruleNameInputId}>
              <span className="text-sm text-slate-300">规则名称</span>
              <input id={ruleNameInputId} value={form.name} onChange={e => updateForm('name', e.target.value)} aria-label="规则名称，保存后会影响后续审核口径" className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60" placeholder="请输入规则名称" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block" htmlFor={ruleCategoryInputId}>
                <span className="text-sm text-slate-300">类别</span>
                <select id={ruleCategoryInputId} value={form.category} onChange={e => updateForm('category', e.target.value)} aria-label="规则类别" className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
                  <option value="通用">通用</option>
                  <option value="内部运营">内部运营</option>
                  <option value="市场拓展">市场拓展</option>
                  <option value="风险阈值">风险阈值</option>
                </select>
              </label>
              <label className="block" htmlFor={ruleStatusInputId}>
                <span className="text-sm text-slate-300">状态</span>
                <select id={ruleStatusInputId} value={form.status} onChange={e => updateForm('status', e.target.value)} aria-label="规则状态" className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
                  <option value="启用">启用</option>
                  <option value="停用">停用</option>
                </select>
              </label>
            </div>
            <label className="block" htmlFor={ruleWeightInputId}>
              <span className="text-sm text-slate-300">权重</span>
              <input id={ruleWeightInputId} type="number" min="1" max="100" value={form.weight} onChange={e => updateForm('weight', e.target.value)} aria-label="规则权重，范围 1 到 100" className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60" />
            </label>
            <label className="block" htmlFor={ruleDescriptionInputId}>
              <span className="text-sm text-slate-300">规则说明</span>
              <textarea id={ruleDescriptionInputId} value={form.description} onChange={e => updateForm('description', e.target.value)} rows={5} aria-label="规则说明，描述规则命中口径和审核影响" className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none" placeholder="请输入规则说明" />
            </label>

            {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
            {message && <div className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">{message}</div>}

            <div className="flex gap-2">
              <button type="submit" disabled={saving} title={saveRuleLabel} aria-label={saveRuleLabel} className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm border border-blue-300/40">
                <Save size={16} aria-hidden="true" />
                {saving ? '保存中...' : '保存'}
              </button>
              {editingId && (
                <button type="button" onClick={resetForm} title="取消编辑当前规则并恢复新增表单" aria-label="取消编辑当前规则并恢复新增表单" className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-blue-500/25 text-slate-300 text-sm">
                  <X size={16} aria-hidden="true" />
                  取消
                </button>
              )}
            </div>
          </form>
        </Panel>

        <Panel className="p-5">
          <h2 className="font-semibold text-blue-100 mb-2">催办草稿与超时规则</h2>
          <p className="mb-4 text-xs leading-5 text-amber-200">系统只生成未发送草稿，不会自动触达企业微信、电话或邮件；真实沟通完成后请在方案中人工登记。</p>
          <div className="space-y-4">
            {reminderStageEntries.map(([key, label]) => {
              const enabledId = `reminder-${key}-enabled`
              const warningId = `reminder-${key}-warning`
              const overdueId = `reminder-${key}-overdue`
              return (
              <div key={key} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm text-slate-200">{label}</div>
                  <label className="inline-flex items-center gap-2 text-xs text-slate-400" htmlFor={enabledId}>
                    <input
                      id={enabledId}
                      type="checkbox"
                      checked={reminderForm[key].enabled}
                      onChange={e => updateReminderStage(key, 'enabled', e.target.checked)}
                      aria-label={`${label}催办规则启用状态`}
                      className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                    />
                    启用
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block" htmlFor={warningId}>
                    <span className="text-xs text-slate-400">预警阈值（小时）</span>
                    <input
                      id={warningId}
                      type="number"
                      min="1"
                      value={reminderForm[key].warningHours}
                      onChange={e => updateReminderStage(key, 'warningHours', e.target.value)}
                      aria-label={`${label}预警阈值，单位小时`}
                      className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                    />
                  </label>
                  <label className="block" htmlFor={overdueId}>
                    <span className="text-xs text-slate-400">超时阈值（小时）</span>
                    <input
                      id={overdueId}
                      type="number"
                      min="1"
                      value={reminderForm[key].overdueHours}
                      onChange={e => updateReminderStage(key, 'overdueHours', e.target.value)}
                      aria-label={`${label}超时阈值，单位小时`}
                      className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                    />
                  </label>
                </div>
              </div>
            )})}

            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4 space-y-3">
              <label className="inline-flex items-center gap-2 text-sm text-slate-300" htmlFor={autoCreateEnabledInputId}>
                <input
                  id={autoCreateEnabledInputId}
                  type="checkbox"
                  checked={reminderForm.autoCreateEnabled}
                  onChange={e => setReminderForm(prev => ({ ...prev, autoCreateEnabled: e.target.checked }))}
                  aria-label="允许生成未发送催办草稿"
                  className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                />
                允许生成未发送催办草稿
              </label>
              <label className="block" htmlFor={defaultChannelInputId}>
                <span className="text-xs text-slate-400">默认催办渠道</span>
                <select
                  id={defaultChannelInputId}
                  value={reminderForm.defaultChannel}
                  onChange={e => setReminderForm(prev => ({ ...prev, defaultChannel: e.target.value }))}
                  aria-label="默认催办渠道"
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
                >
                  {['企业微信', '电话', '邮件', '当面沟通'].map(option => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={saveReminderConfig}
                disabled={savingReminderConfig}
                title={reminderSaveLabel}
                aria-label={reminderSaveLabel}
                className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm border border-cyan-300/40"
              >
                <Save size={16} aria-hidden="true" />
                {savingReminderConfig ? '保存中...' : '保存催办规则'}
              </button>
            </div>
          </div>
        </Panel>
      </aside>
    </div>
  )
}
