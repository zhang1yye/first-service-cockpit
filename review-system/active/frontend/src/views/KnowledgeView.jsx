import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { BookText, Download, Edit3, Plus, Power, Save, Search, Trash2, Upload, Wand2, X } from '../lib/lucide.js'
import { api, downloadFile, uploadFile } from '../lib/api'
import { uploadFormatError } from '../lib/uploadValidation'
import Panel from '../components/Panel'

const emptyForm = {
  profileId: 'investment',
  clauseCode: '',
  title: '',
  source: '',
  content: '',
  keywords: '',
  priority: '中',
  status: '停用'
}

const splitKeywords = (value = '') => String(value)
  .split(/[，,、；;\n]/)
  .map(item => item.trim())
  .filter(Boolean)

const normalizeClauseCode = (value = '') => String(value).trim().toUpperCase()

const buildClauseKey = (profileId = '', clauseCode = '') => {
  const normalizedProfileId = String(profileId).trim()
  const normalizedClauseCode = normalizeClauseCode(clauseCode)
  if (!normalizedProfileId || !normalizedClauseCode) return ''
  return `${normalizedProfileId}::${normalizedClauseCode}`
}

const draftIssueTypeOptions = [
  { value: 'all', label: '全部异常' },
  { value: 'clauseCode', label: '编号异常' },
  { value: 'title', label: '标题异常' },
  { value: 'content', label: '内容异常' }
]

const domIdSegment = (value = '') => String(value || 'item').replace(/[^a-zA-Z0-9_-]/g, '-')

export default function KnowledgeView() {
  const [profiles, setProfiles] = useState([])
  const [items, setItems] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [templateDownloading, setTemplateDownloading] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [savingDrafts, setSavingDrafts] = useState(false)
  const [query, setQuery] = useState('')
  const [profileFilter, setProfileFilter] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [draftProfileId, setDraftProfileId] = useState('investment')
  const [draftSourceName, setDraftSourceName] = useState('')
  const [drafts, setDrafts] = useState([])
  const [selectedDraftIds, setSelectedDraftIds] = useState([])
  const [selectedItemIds, setSelectedItemIds] = useState([])
  const [actingBulk, setActingBulk] = useState(false)
  const [showDraftIssuesOnly, setShowDraftIssuesOnly] = useState(false)
  const [draftIssueFilter, setDraftIssueFilter] = useState('all')
  const [draftFileInfo, setDraftFileInfo] = useState(null)
  const fileInputRef = useRef(null)
  const draftInputRef = useRef(null)
  const queryInputId = useId()
  const profileFilterId = useId()
  const allFilteredItemsId = useId()
  const allDraftsId = useId()
  const showDraftIssuesOnlyId = useId()
  const draftProfileInputId = useId()
  const draftSourceInputId = useId()
  const formProfileId = useId()
  const formClauseCodeId = useId()
  const formPriorityId = useId()
  const formTitleId = useId()
  const formSourceId = useId()
  const formContentId = useId()
  const formKeywordsId = useId()
  const formStatusId = useId()

  const loadData = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.get('/knowledge')
      setItems(data.items || [])
      setProfiles(data.profiles || [])
      if ((data.profiles || []).length > 0) {
        setForm(prev => ({ ...prev, profileId: prev.profileId || data.profiles[0].id }))
        setDraftProfileId(prev => prev || data.profiles[0].id)
      }
    } catch (err) {
      setError(err.message || '知识库加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    if (!showDraftIssuesOnly && draftIssueFilter !== 'all') {
      setDraftIssueFilter('all')
    }
  }, [draftIssueFilter, showDraftIssuesOnly])

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return items.filter(item => {
      const matchProfile = !profileFilter || item.profileId === profileFilter
      const matchQuery = !keyword || [
        item.title,
        item.clauseCode,
        item.source,
        item.content,
        ...(item.keywords || [])
      ].join(' ').toLowerCase().includes(keyword)
      return matchProfile && matchQuery
    })
  }, [items, profileFilter, query])

  const enabledItemCount = items.filter(item => item.status === '启用').length
  const disabledItemCount = items.length - enabledItemCount
  const highPriorityCount = items.filter(item => item.priority === '高').length
  const selectedItems = useMemo(
    () => filteredItems.filter(item => selectedItemIds.includes(item.id)),
    [filteredItems, selectedItemIds]
  )
  const allFilteredSelected = filteredItems.length > 0 && filteredItems.every(item => selectedItemIds.includes(item.id))
  const selectedEnabledCount = selectedItems.filter(item => item.status === '启用').length
  const selectedDisabledCount = selectedItems.filter(item => item.status !== '启用').length

  const existingClauseMap = useMemo(() => new Map(
    items.map(item => [buildClauseKey(item.profileId, item.clauseCode), item])
  ), [items])

  const profileNameMap = useMemo(() => new Map(
    profiles.map(profile => [profile.id, profile.name])
  ), [profiles])

  const selectedItemPreview = useMemo(
    () => selectedItems
      .slice(0, 5)
      .map(item => `《${item.title}》${item.clauseCode ? `（${item.clauseCode}）` : ''}`)
      .join('、'),
    [selectedItems]
  )
  const knowledgeFilterSummary = `专业：${profileFilter ? (profileNameMap.get(profileFilter) || profileFilter) : '全部专业'}；关键词：${query.trim() || '无'}；结果数：${filteredItems.length}`
  const selectedKnowledgeSummary = selectedItemIds.length > 0
    ? `当前已选择 ${selectedItemIds.length} 条知识条款，启用 ${selectedEnabledCount} 条，停用 ${selectedDisabledCount} 条`
    : '当前未选择知识条款'
  const knowledgeBulkActionLabel = (action, confirmText = '') => {
    if (actingBulk) return `${action}暂不可用：正在执行批量知识库操作`
    if (selectedItemIds.length === 0) return `${action}暂不可用：请先选择知识条款`
    return `${action}：${selectedKnowledgeSummary}${confirmText ? `，执行前需要输入“${confirmText}”确认` : ''}`
  }
  const knowledgeIoLabel = (action, running = false) => (
    `${running ? '正在' : ''}${action}，当前知识库共 ${items.length} 条，当前筛选 ${filteredItems.length} 条；导入或修改会影响后续审核依据、规则命中和 AI 参考材料`
  )

  const draftValidationMap = useMemo(() => {
    const sameBatchCounter = new Map()
    const validationMap = new Map()

    drafts.forEach(draft => {
      const issues = []
      const issueTypes = new Set()
      const clauseCode = normalizeClauseCode(draft.clauseCode)
      const title = String(draft.title || '').trim()
      const content = String(draft.content || '').trim()
      const clauseKey = buildClauseKey(draft.profileId, clauseCode)

      if (!clauseCode) {
        issues.push('条款编号不能为空')
        issueTypes.add('clauseCode')
      }
      if (title.length < 2) {
        issues.push('条款标题不少于 2 个字符')
        issueTypes.add('title')
      }
      if (content.length < 6) {
        issues.push('条款内容不少于 6 个字符')
        issueTypes.add('content')
      }

      if (clauseKey) {
        sameBatchCounter.set(clauseKey, (sameBatchCounter.get(clauseKey) || 0) + 1)
        const existingItem = existingClauseMap.get(clauseKey)
        if (existingItem) {
          issues.push(`与知识库现有条款《${existingItem.title}》编号重复`)
          issueTypes.add('clauseCode')
        }
      }

      validationMap.set(draft.id, {
        hasIssue: issues.length > 0,
        issues,
        issueTypes: [...issueTypes],
        clauseCode
      })
    })

    drafts.forEach(draft => {
      const validation = validationMap.get(draft.id)
      const clauseKey = buildClauseKey(draft.profileId, draft.clauseCode)
      if (clauseKey && (sameBatchCounter.get(clauseKey) || 0) > 1) {
        validation.issues.push('与本批草稿存在重复编号')
        validation.hasIssue = true
        validation.issueTypes = [...new Set([...(validation.issueTypes || []), 'clauseCode'])]
      }
    })

    return validationMap
  }, [drafts, existingClauseMap])

  const draftIssueStats = useMemo(() => {
    const stats = { all: 0, clauseCode: 0, title: 0, content: 0 }
    drafts.forEach(draft => {
      const validation = draftValidationMap.get(draft.id)
      if (!validation?.hasIssue) return
      stats.all += 1
      for (const type of validation.issueTypes || []) {
        if (type in stats) stats[type] += 1
      }
    })
    return stats
  }, [drafts, draftValidationMap])

  const draftIssueCount = draftIssueStats.all

  const visibleDrafts = useMemo(
    () => drafts.filter(draft => {
      const validation = draftValidationMap.get(draft.id)
      const hasIssue = validation?.hasIssue
      if (!showDraftIssuesOnly) return true
      if (!hasIssue) return false
      if (draftIssueFilter === 'all') return true
      return (validation.issueTypes || []).includes(draftIssueFilter)
    }),
    [draftIssueFilter, drafts, draftValidationMap, showDraftIssuesOnly]
  )

  const selectedDrafts = useMemo(
    () => drafts.filter(draft => selectedDraftIds.includes(draft.id)),
    [drafts, selectedDraftIds]
  )

  const allDraftSelected = drafts.length > 0 && selectedDraftIds.length === drafts.length
  const selectedDraftIssueCount = selectedDrafts.filter(draft => draftValidationMap.get(draft.id)?.hasIssue).length
  const hasDraftSelectionIssue = selectedDraftIssueCount > 0
  const draftFilterSummary = `草稿总数：${drafts.length}；当前显示：${visibleDrafts.length}；异常筛选：${showDraftIssuesOnly ? draftIssueTypeOptions.find(option => option.value === draftIssueFilter)?.label || '异常项' : '全部草稿'}；异常数：${draftIssueCount}`
  const formClauseConflict = useMemo(() => {
    const clauseCode = normalizeClauseCode(form.clauseCode)
    if (!clauseCode) return null
    const clauseKey = buildClauseKey(form.profileId, clauseCode)
    const matchedItem = existingClauseMap.get(clauseKey)
    if (!matchedItem) return null
    if (editingId && matchedItem.id === editingId) return null
    return matchedItem
  }, [editingId, existingClauseMap, form.clauseCode, form.profileId])

  const updateForm = (key, value) => setForm(prev => ({ ...prev, [key]: value }))

  const toggleItem = (itemId) => {
    setSelectedItemIds(prev => (
      prev.includes(itemId)
        ? prev.filter(id => id !== itemId)
        : [...prev, itemId]
    ))
  }

  const toggleAllFilteredItems = () => {
    if (allFilteredSelected) {
      const filteredIdSet = new Set(filteredItems.map(item => item.id))
      setSelectedItemIds(prev => prev.filter(id => !filteredIdSet.has(id)))
      return
    }

    setSelectedItemIds(prev => [...new Set([...prev, ...filteredItems.map(item => item.id)])])
  }

  const resetForm = () => {
    setForm({
      ...emptyForm,
      profileId: profiles[0]?.id || 'investment'
    })
    setEditingId('')
    setMessage('')
    setError('')
  }

  const editItem = (item) => {
    setEditingId(item.id)
    setForm({
      profileId: item.profileId,
      clauseCode: item.clauseCode,
      title: item.title,
      source: item.source,
      content: item.content,
      keywords: (item.keywords || []).join('，'),
      priority: item.priority,
      status: item.status
    })
    setMessage('')
    setError('')
  }

  const saveItem = async (e) => {
    e.preventDefault()
    if (formClauseConflict) {
      setError(`条款编号 ${normalizeClauseCode(form.clauseCode)} 已被《${formClauseConflict.title}》使用`)
      setMessage('')
      return
    }
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const payload = {
        ...form,
        clauseCode: form.clauseCode.trim(),
        title: form.title.trim(),
        source: form.source.trim(),
        content: form.content.trim(),
        keywords: splitKeywords(form.keywords),
        sourceVerified: form.status === '启用'
      }
      const confirmText = editingId ? '保存知识条款' : '新增知识条款'
      const typed = window.prompt(`${editingId ? `确认保存知识条款《${payload.title}》的变更？` : `确认新增知识条款《${payload.title}》？`}\n该操作会影响后续审核依据、规则命中和 AI 参考材料。${form.status === '启用' ? '\n启用前必须已经核对正式来源原件；当前确认将作为本次启用留痕。' : '\n当前条款保持停用，不会参与审核。'}\n\n如确认继续，请输入：${confirmText}`)?.trim()
      if (typed !== confirmText) {
        setError(`知识条款保存已取消：需输入“${confirmText}”才会执行。`)
        return
      }
      payload.confirmText = confirmText

      if (editingId) {
        await api.patch(`/knowledge/${editingId}`, payload)
        setMessage('知识条款修改成功')
      } else {
        await api.post('/knowledge', payload)
        setMessage('知识条款新增成功')
      }

      resetForm()
      await loadData()
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const exportCsv = async () => {
    setExporting(true)
    setError('')
    setMessage('')
    try {
      await downloadFile('/knowledge/export', '专业知识库.csv')
      setMessage('知识库 CSV 已导出')
    } catch (err) {
      setError(err.message || '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const downloadTemplate = async () => {
    setTemplateDownloading(true)
    setError('')
    setMessage('')
    try {
      await downloadFile('/knowledge/template', '知识库导入模板.csv')
      setMessage('知识库模板已下载')
    } catch (err) {
      setError(err.message || '模板下载失败')
    } finally {
      setTemplateDownloading(false)
    }
  }

  const importCsv = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    const formatError = uploadFormatError(file, ['.csv'], '知识库导入文件')
    if (formatError) {
      setError(formatError)
      setMessage('')
      e.target.value = ''
      return
    }

    setImporting(true)
    setError('')
    setMessage('')
    try {
      const confirmText = '导入知识库'
      const typed = window.prompt(`确认导入知识库文件《${file.name}》？\n导入会新增或更新知识条款，影响后续审核依据。\n\n如确认继续，请输入：${confirmText}`)?.trim()
      if (typed !== confirmText) {
        setError(`知识库导入已取消：需输入“${confirmText}”才会执行。`)
        return
      }
      const result = await uploadFile('/knowledge/import', file, 'file', { confirmText })
      setMessage(`导入完成，新增 ${result.created || 0} 条，更新 ${result.updated || 0} 条`)
      await loadData()
    } catch (err) {
      setError(err.message || '导入失败')
    } finally {
      e.target.value = ''
      setImporting(false)
    }
  }

  const deleteItem = async (item) => {
    const confirmText = '删除知识条款'
    const typed = window.prompt(`删除知识条款《${item.title}》后不可恢复。\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`删除已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setError('')
    setMessage('')
    try {
      await api.delete(`/knowledge/${item.id}`, { confirmText })
      setMessage(`已删除条款《${item.title}》`)
      await loadData()
    } catch (err) {
      setError(err.message || '删除失败')
    }
  }

  const bulkUpdateStatus = async (status) => {
    if (selectedItemIds.length === 0) return
    const actionText = status === '启用' ? '启用' : '停用'
    const previewText = selectedItemPreview || '当前选中的知识条款'
    const moreText = selectedItemIds.length > 5 ? `\n其余 ${selectedItemIds.length - 5} 条不会在确认框中展开。` : ''
    const confirmText = '批量更新知识状态'
    const typed = window.prompt(`确认批量${actionText}选中的 ${selectedItemIds.length} 条知识条款？\n${previewText}${moreText}${status === '启用' ? '\n启用前必须逐条核对正式来源原件；当前确认将作为本次启用留痕。' : ''}\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`批量状态更新已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingBulk(true)
    setError('')
    setMessage('')
    try {
      const result = await api.post('/knowledge/bulk-status', { ids: selectedItemIds, status, confirmText, sourceVerified: status === '启用' })
      setSelectedItemIds([])
      const titles = Array.isArray(result.items) ? result.items.map(item => item.title).filter(Boolean) : []
      const titleText = titles.length ? `：${titles.slice(0, 5).map(title => `《${title}》`).join('、')}${titles.length > 5 ? ` 等 ${titles.length} 条` : ''}` : ''
      setMessage(`已${actionText} ${result.updated || 0} 条知识条款${titleText}`)
      await loadData()
    } catch (err) {
      setError(err.message || '批量状态更新失败')
    } finally {
      setActingBulk(false)
    }
  }

  const bulkDeleteItems = async () => {
    if (selectedItemIds.length === 0) return
    const previewText = selectedItemPreview || '当前选中的知识条款'
    const moreText = selectedItemIds.length > 5 ? `\n其余 ${selectedItemIds.length - 5} 条不会在确认框中展开。` : ''
    const confirmText = `删除${selectedItemIds.length}条知识条款`
    const typed = window.prompt(`删除选中的 ${selectedItemIds.length} 条知识条款后不可恢复。\n${previewText}${moreText}\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`批量删除已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingBulk(true)
    setError('')
    setMessage('')
    try {
      const result = await api.post('/knowledge/bulk-delete', { ids: selectedItemIds, confirmText })
      setSelectedItemIds([])
      const titles = Array.isArray(result.titles) ? result.titles.filter(Boolean) : []
      const titleText = titles.length ? `：${titles.slice(0, 5).map(title => `《${title}》`).join('、')}${titles.length > 5 ? ` 等 ${titles.length} 条` : ''}` : ''
      setMessage(`已删除 ${result.removed || 0} 条知识条款${titleText}`)
      await loadData()
    } catch (err) {
      setError(err.message || '批量删除失败')
    } finally {
      setActingBulk(false)
    }
  }

  const generateDrafts = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    const formatError = uploadFormatError(file, ['.txt', '.docx', '.pdf'], '制度文件')
    if (formatError) {
      setError(formatError)
      setMessage('')
      e.target.value = ''
      return
    }

    setDrafting(true)
    setError('')
    setMessage('')
    try {
      const result = await uploadFile('/knowledge/draft', file, 'file', {
        profileId: draftProfileId,
        sourceName: draftSourceName.trim()
      })
      const nextDrafts = (result.drafts || []).map((draft, index) => ({
        ...draft,
        id: `${draft.clauseCode || 'DRAFT'}-${Date.now()}-${index}`
      }))
      setDrafts(nextDrafts)
      setSelectedDraftIds(nextDrafts.map(draft => draft.id))
      setDraftFileInfo(result.file || null)
      setMessage(`已生成 ${result.drafts?.length || 0} 条草稿`)
    } catch (err) {
      setError(err.message || '草稿生成失败')
    } finally {
      e.target.value = ''
      setDrafting(false)
    }
  }

  const saveDrafts = async () => {
    if (selectedDrafts.length === 0) return
    if (hasDraftSelectionIssue) {
      setError(`所选草稿中有 ${selectedDraftIssueCount} 条存在编号或内容问题，请先修正`)
      setMessage('')
      return
    }

    setSavingDrafts(true)
    setError('')
    setMessage('')
    try {
      const payload = selectedDrafts.map(({ id, matchedTerms, ...draft }) => draft)
      const confirmText = '批量新增知识条款'
      const typed = window.prompt(`确认将选中的 ${payload.length} 条草稿批量新增到知识库？\n该操作会影响后续审核依据。\n\n如确认继续，请输入：${confirmText}`)?.trim()
      if (typed !== confirmText) {
        setError(`草稿入库已取消：需输入“${confirmText}”才会执行。`)
        return
      }
      const result = await api.post('/knowledge/bulk', { items: payload, confirmText })
      setMessage(`已批量新增 ${result.created || 0} 条知识条款`)
      const restDrafts = drafts.filter(draft => !selectedDraftIds.includes(draft.id))
      setDrafts(restDrafts)
      setSelectedDraftIds([])
      if (restDrafts.length === 0) setDraftFileInfo(null)
      await loadData()
    } catch (err) {
      const conflictItems = err.data?.conflictItems || []
      if (conflictItems.length > 0) {
        setError(`草稿导入失败：${conflictItems.slice(0, 2).map(item => `${item.clauseCode} ${item.reason}`).join('；')}`)
      } else {
        setError(err.message || '草稿导入失败')
      }
    } finally {
      setSavingDrafts(false)
    }
  }

  const updateDraft = (draftId, key, value) => {
    setDrafts(prev => prev.map(draft => {
      if (draft.id !== draftId) return draft
      if (key === 'keywords') {
        return {
          ...draft,
          keywords: splitKeywords(value)
        }
      }
      if (key === 'clauseCode') return { ...draft, clauseCode: normalizeClauseCode(value) }
      return { ...draft, [key]: value }
    }))
  }

  const toggleDraft = (draftId) => {
    setSelectedDraftIds(prev => (
      prev.includes(draftId)
        ? prev.filter(id => id !== draftId)
        : [...prev, draftId]
    ))
  }

  const toggleAllDrafts = () => {
    setSelectedDraftIds(allDraftSelected ? [] : drafts.map(draft => draft.id))
  }

  const removeDraft = (draftId) => {
    setDrafts(prev => {
      const next = prev.filter(draft => draft.id !== draftId)
      if (next.length === 0) setDraftFileInfo(null)
      return next
    })
    setSelectedDraftIds(prev => prev.filter(id => id !== draftId))
  }

  const collectDraftReservedKeys = (excludeDraftId = '') => {
    const reservedKeys = new Set(existingClauseMap.keys())
    drafts.forEach(draft => {
      if (draft.id === excludeDraftId) return
      const clauseKey = buildClauseKey(draft.profileId, draft.clauseCode)
      if (clauseKey) reservedKeys.add(clauseKey)
    })
    return reservedKeys
  }

  const suggestDraftClauseCode = (draft) => {
    const profile = profiles.find(item => item.id === draft.profileId)
    const prefix = `${String(profile?.code || 'KN').toUpperCase()}-D`
    const reservedKeys = collectDraftReservedKeys(draft.id)
    let cursor = 1

    while (cursor < 9999) {
      const nextCode = `${prefix}${String(cursor).padStart(2, '0')}`
      const clauseKey = buildClauseKey(draft.profileId, nextCode)
      if (!reservedKeys.has(clauseKey)) return nextCode
      cursor += 1
    }

    return `${prefix}${Date.now().toString().slice(-4)}`
  }

  const autoFixDraftCode = (draftId) => {
    const targetDraft = drafts.find(item => item.id === draftId)
    if (!targetDraft) return
    updateDraft(draftId, 'clauseCode', suggestDraftClauseCode(targetDraft))
  }

  const autoFixAllDraftCodes = () => {
    if (draftIssueCount === 0) {
      setMessage('当前草稿没有编号异常，无需自动修复')
      setError('')
      return
    }

    let reservedKeys = new Set(existingClauseMap.keys())
    const nextDrafts = drafts.map(draft => {
      const validation = draftValidationMap.get(draft.id)
      const hasClauseCodeIssue = (validation?.issueTypes || []).includes('clauseCode')
      if (!validation?.hasIssue || !hasClauseCodeIssue) {
        const currentKey = buildClauseKey(draft.profileId, draft.clauseCode)
        if (currentKey) reservedKeys.add(currentKey)
        return draft
      }

      const profile = profiles.find(item => item.id === draft.profileId)
      const prefix = `${String(profile?.code || 'KN').toUpperCase()}-D`
      let cursor = 1
      let nextCode = ''

      while (!nextCode && cursor < 9999) {
        const candidate = `${prefix}${String(cursor).padStart(2, '0')}`
        const candidateKey = buildClauseKey(draft.profileId, candidate)
        if (!reservedKeys.has(candidateKey)) {
          nextCode = candidate
          reservedKeys.add(candidateKey)
        }
        cursor += 1
      }

      return { ...draft, clauseCode: nextCode || `${prefix}${Date.now().toString().slice(-4)}` }
    })

    setDrafts(nextDrafts)
    setMessage('已自动生成建议编号，请复核后导入')
    setError('')
  }

  const priorityClass = {
    高: 'text-red-300 bg-red-500/10 border-red-400/30',
    中: 'text-amber-300 bg-amber-500/10 border-amber-400/30',
    低: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/30'
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      <section className="col-span-12 xl:col-span-8 space-y-4">
        <Panel className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h1 className="text-xl font-bold text-blue-200 flex items-center gap-2">
                <BookText size={21} aria-hidden="true" />
                专业知识库
              </h1>
              <p className="text-sm text-slate-400 mt-1">维护审核机器人条款、关键词和优先级，供 AI 审核命中引用。</p>
            </div>
            <button
              type="button"
              onClick={resetForm}
              title="切换到新增知识条款表单"
              aria-label="切换到新增知识条款表单"
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-400/40 bg-blue-600/20 text-blue-100 text-sm"
            >
              <Plus size={16} aria-hidden="true" />
              新增条款
            </button>
          </div>

          <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-100">
            只有已核对正式来源原件的条款才可启用并参与审核。新增条款默认停用；来源不明、仅有模板名称或未完成审批的内容必须保持停用。
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="text-xs text-slate-500">启用条款</div>
              <div className="mt-2 text-2xl font-bold text-emerald-200">{enabledItemCount}</div>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="text-xs text-slate-500">停用条款</div>
              <div className="mt-2 text-2xl font-bold text-slate-200">{disabledItemCount}</div>
            </div>
            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
              <div className="text-xs text-slate-500">高优先级条款</div>
              <div className="mt-2 text-2xl font-bold text-red-200">{highPriorityCount}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            <button
              type="button"
              onClick={exportCsv}
              disabled={exporting}
              title={knowledgeIoLabel('导出知识库 CSV', exporting)}
              aria-label={knowledgeIoLabel('导出知识库 CSV', exporting)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-400/40 bg-emerald-500/15 text-emerald-100 text-sm disabled:opacity-50"
            >
              <Download size={15} aria-hidden="true" />
              {exporting ? '导出中...' : '导出 CSV'}
            </button>
            <button
              type="button"
              onClick={downloadTemplate}
              disabled={templateDownloading}
              title={templateDownloading ? '正在下载知识库导入模板' : '下载知识库导入模板，建议导入前先按模板整理 CSV 字段'}
              aria-label={templateDownloading ? '正在下载知识库导入模板' : '下载知识库导入模板，建议导入前先按模板整理 CSV 字段'}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cyan-400/40 bg-cyan-500/15 text-cyan-100 text-sm disabled:opacity-50"
            >
              <Download size={15} aria-hidden="true" />
              {templateDownloading ? '下载中...' : '下载模板'}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              title={knowledgeIoLabel('导入知识库 CSV', importing)}
              aria-label={knowledgeIoLabel('导入知识库 CSV', importing)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-400/40 bg-amber-500/15 text-amber-100 text-sm disabled:opacity-50"
            >
              <Upload size={15} aria-hidden="true" />
              {importing ? '导入中...' : '导入 CSV'}
            </button>
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={importCsv} aria-label="选择知识库 CSV 导入文件" />
          </div>
          <div className="mb-4 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
            知识库导入仅支持 CSV 文件；建议先下载模板，按 profileId、clauseCode、title、content 等列整理后再导入。
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-3 mb-4">
            <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/75" htmlFor={queryInputId}>
              <Search size={16} className="text-slate-400" aria-hidden="true" />
              <input
                id={queryInputId}
                value={query}
                onChange={e => setQuery(e.target.value)}
                aria-label={`搜索知识条款，当前筛选：${knowledgeFilterSummary}`}
                className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
                placeholder="搜索条款编号、标题、来源、关键词"
              />
            </label>
            <select
              id={profileFilterId}
              value={profileFilter}
              onChange={e => setProfileFilter(e.target.value)}
              title={`按专业筛选知识条款，当前筛选：${knowledgeFilterSummary}`}
              aria-label={`按专业筛选知识条款，当前筛选：${knowledgeFilterSummary}`}
              className="px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
            >
              <option value="">全部专业</option>
              {profiles.map(profile => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          </div>

          <div className="rounded-lg border border-blue-500/20 bg-slate-950/45 px-3 py-3 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex items-center gap-2 text-sm text-slate-300" htmlFor={allFilteredItemsId}>
                <input
                  id={allFilteredItemsId}
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleAllFilteredItems}
                  className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                  title={`${allFilteredSelected ? '取消选择' : '选择'}当前筛选结果 ${filteredItems.length} 条知识条款`}
                  aria-label={`${allFilteredSelected ? '取消选择' : '选择'}当前筛选结果 ${filteredItems.length} 条知识条款，筛选条件：${knowledgeFilterSummary}`}
                />
                当前筛选结果全选
              </label>
              <div className="text-xs text-slate-400">
                已选 {selectedItemIds.length} 条，启用 {selectedEnabledCount}，停用 {selectedDisabledCount}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => bulkUpdateStatus('启用')}
                disabled={actingBulk || selectedItemIds.length === 0}
                title={knowledgeBulkActionLabel('批量启用知识条款', '批量更新知识状态')}
                aria-label={knowledgeBulkActionLabel('批量启用知识条款', '批量更新知识状态')}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-400/40 bg-emerald-500/15 text-emerald-100 text-sm disabled:opacity-50"
              >
                <Power size={15} aria-hidden="true" />
                批量启用
              </button>
              <button
                type="button"
                onClick={() => bulkUpdateStatus('停用')}
                disabled={actingBulk || selectedItemIds.length === 0}
                title={knowledgeBulkActionLabel('批量停用知识条款', '批量更新知识状态')}
                aria-label={knowledgeBulkActionLabel('批量停用知识条款', '批量更新知识状态')}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-400/40 bg-amber-500/15 text-amber-100 text-sm disabled:opacity-50"
              >
                <Power size={15} aria-hidden="true" />
                批量停用
              </button>
              <button
                type="button"
                onClick={bulkDeleteItems}
                disabled={actingBulk || selectedItemIds.length === 0}
                title={knowledgeBulkActionLabel('批量删除知识条款', `删除${selectedItemIds.length}条知识条款`)}
                aria-label={knowledgeBulkActionLabel('批量删除知识条款', `删除${selectedItemIds.length}条知识条款`)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-400/40 bg-red-500/15 text-red-100 text-sm disabled:opacity-50"
              >
                <Trash2 size={15} aria-hidden="true" />
                批量删除
              </button>
            </div>
          </div>

          {loading ? (
            <div className="text-center py-12 text-slate-400">加载中...</div>
          ) : (
            <div className="space-y-3">
              {filteredItems.length === 0 ? (
                <div className="rounded-lg border border-blue-500/20 bg-slate-900/55 px-4 py-8 text-center text-sm text-slate-500">
                  暂无匹配条款
                </div>
              ) : filteredItems.map(item => {
                const itemCheckboxId = `knowledge-item-${domIdSegment(item.id)}`
                return (
                <div key={item.id} className="rounded-lg border border-blue-500/20 bg-slate-900/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <label className="inline-flex items-start gap-3 w-full" htmlFor={itemCheckboxId}>
                        <input
                          id={itemCheckboxId}
                          type="checkbox"
                          checked={selectedItemIds.includes(item.id)}
                          onChange={() => toggleItem(item.id)}
                          className="mt-1 h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                          aria-label={`${selectedItemIds.includes(item.id) ? '取消选择' : '选择'}知识条款《${item.title || '未命名条款'}》，编号 ${item.clauseCode || '未编号'}，专业 ${item.profileName || '未记录'}，状态 ${item.status || '未知'}，优先级 ${item.priority || '未设置'}`}
                        />
                        <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="px-2 py-1 rounded text-xs border border-cyan-400/30 text-cyan-300 bg-cyan-500/10">{item.clauseCode}</span>
                        <span className="px-2 py-1 rounded text-xs border border-blue-400/30 text-blue-200 bg-blue-500/10">{item.profileName}</span>
                        <span className={`px-2 py-1 rounded text-xs border ${priorityClass[item.priority] || priorityClass.中}`}>{item.priority}优先级</span>
                        <span className={`px-2 py-1 rounded text-xs border ${item.status === '启用' ? 'text-emerald-300 bg-emerald-500/10 border-emerald-400/30' : 'text-slate-300 bg-slate-500/10 border-slate-400/30'}`}>{item.status}</span>
                      </div>
                      <div className="font-semibold text-blue-100">{item.title}</div>
                      <div className="text-xs text-slate-500 mt-1">{item.source} · 更新于 {item.updatedAt}</div>
                        </div>
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => editItem(item)}
                      title={`修改知识条款《${item.title || '未命名条款'}》，编号 ${item.clauseCode || '未编号'}，专业 ${item.profileName || '未记录'}`}
                      aria-label={`修改知识条款《${item.title || '未命名条款'}》，编号 ${item.clauseCode || '未编号'}，专业 ${item.profileName || '未记录'}，状态 ${item.status || '未知'}`}
                      className="inline-flex items-center gap-1 text-blue-300 hover:text-blue-200 text-sm shrink-0"
                    >
                      <Edit3 size={15} aria-hidden="true" />
                      修改
                    </button>
                  </div>
                  <p className="text-sm text-slate-300 mt-3 leading-6">{item.content}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(item.keywords || []).map(keyword => (
                      <span key={`${item.id}-${keyword}`} className="px-2 py-1 rounded text-xs border border-blue-400/20 bg-slate-950/60 text-slate-300">
                        {keyword}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => deleteItem(item)}
                      title={`删除知识条款《${item.title || '未命名条款'}》，执行前需要输入“删除知识条款”确认`}
                      aria-label={`删除知识条款《${item.title || '未命名条款'}》，编号 ${item.clauseCode || '未编号'}，执行前需要输入“删除知识条款”确认`}
                      className="inline-flex items-center gap-1 text-red-300 hover:text-red-200 text-sm"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                      删除
                    </button>
                  </div>
                </div>
              )})}
            </div>
          )}
        </Panel>
      </section>

      <aside className="col-span-12 xl:col-span-4">
        <Panel className="p-5">
          <h2 className="font-semibold text-blue-100 mb-4 flex items-center gap-2">
            <Wand2 size={18} aria-hidden="true" />
            制度文件生成草稿
          </h2>
          <div className="space-y-4 mb-6">
            <label className="block" htmlFor={draftProfileInputId}>
              <span className="text-sm text-slate-300">目标专业</span>
              <select id={draftProfileInputId} value={draftProfileId} onChange={e => setDraftProfileId(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
                {profiles.map(profile => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
            </label>
            <label className="block" htmlFor={draftSourceInputId}>
              <span className="text-sm text-slate-300">来源名称</span>
              <input id={draftSourceInputId} value={draftSourceName} onChange={e => setDraftSourceName(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60" placeholder="如 2026客服制度汇编" />
            </label>
            <button
              type="button"
              onClick={() => draftInputRef.current?.click()}
              disabled={drafting}
              title={drafting ? '正在生成知识草稿' : '上传制度文件生成知识条款草稿'}
              aria-label={drafting ? '正在生成知识草稿' : '上传制度文件生成知识条款草稿'}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-violet-400/40 bg-violet-500/15 text-violet-100 text-sm disabled:opacity-50"
            >
              <Wand2 size={16} aria-hidden="true" />
              {drafting ? '生成中...' : '上传制度文件生成草稿'}
            </button>
            <div className="rounded-lg border border-violet-400/20 bg-violet-500/10 px-3 py-2 text-xs leading-5 text-violet-100">
              草稿生成仅支持 TXT、DOCX、PDF；旧版 DOC 请先转换为 DOCX。
            </div>
            <input ref={draftInputRef} type="file" accept=".txt,.docx,.pdf" className="hidden" onChange={generateDrafts} />
            {draftFileInfo && (
              <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
                {draftFileInfo.name} · {draftFileInfo.extractionStatus} · {draftFileInfo.wordCount} 字符
              </div>
            )}
            {drafts.length > 0 && (
              <div className="space-y-3">
                <div className="rounded-lg border border-violet-400/20 bg-slate-950/50 px-3 py-3 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="inline-flex items-center gap-2 text-sm text-slate-300" htmlFor={allDraftsId}>
                      <input
                        id={allDraftsId}
                        type="checkbox"
                        checked={allDraftSelected}
                        onChange={toggleAllDrafts}
                        className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-violet-500 focus:ring-violet-400/40"
                        title={`${allDraftSelected ? '取消选择' : '选择'}全部 ${drafts.length} 条草稿`}
                        aria-label={`${allDraftSelected ? '取消选择' : '选择'}全部 ${drafts.length} 条草稿，当前筛选：${draftFilterSummary}`}
                      />
                      全选草稿
                    </label>
                    <div className="text-xs text-slate-400">
                      已选 {selectedDraftIds.length} / {drafts.length}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-300" htmlFor={showDraftIssuesOnlyId}>
                      <input
                        id={showDraftIssuesOnlyId}
                        type="checkbox"
                        checked={showDraftIssuesOnly}
                        onChange={e => setShowDraftIssuesOnly(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-violet-500 focus:ring-violet-400/40"
                        title={`${showDraftIssuesOnly ? '关闭' : '开启'}草稿异常项筛选`}
                        aria-label={`${showDraftIssuesOnly ? '关闭' : '开启'}草稿异常项筛选，当前异常 ${draftIssueCount} 条，${draftFilterSummary}`}
                      />
                      只看异常项
                    </label>
                    {showDraftIssuesOnly && (
                      <div className="flex flex-wrap items-center gap-2">
                        {draftIssueTypeOptions.map(option => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setDraftIssueFilter(option.value)}
                            title={`查看${option.label}，当前 ${option.value in draftIssueStats ? draftIssueStats[option.value] : 0} 条`}
                            aria-pressed={draftIssueFilter === option.value}
                            aria-label={`${draftIssueFilter === option.value ? '当前已选择' : '切换到'}${option.label}筛选，当前 ${option.value in draftIssueStats ? draftIssueStats[option.value] : 0} 条`}
                            className={`px-3 py-1.5 rounded-lg border text-xs ${
                              draftIssueFilter === option.value
                                ? 'border-violet-300/50 bg-violet-500/20 text-violet-100'
                                : 'border-blue-500/20 bg-slate-950/50 text-slate-400'
                            }`}
                          >
                            {option.label}
                            {option.value in draftIssueStats ? ` ${draftIssueStats[option.value]}` : ''}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={autoFixAllDraftCodes}
                      disabled={draftIssueCount === 0}
                      title={draftIssueCount === 0 ? '当前没有需要自动修复的草稿编号' : `自动修复 ${draftIssueStats.clauseCode || 0} 条编号异常建议`}
                      aria-label={draftIssueCount === 0 ? '当前没有需要自动修复的草稿编号' : `自动修复 ${draftIssueStats.clauseCode || 0} 条编号异常建议`}
                      className="px-3 py-1.5 rounded-lg border border-violet-400/30 bg-violet-500/10 text-violet-100 text-xs disabled:opacity-40"
                    >
                      自动修复建议编号
                    </button>
                    <div className="text-xs text-slate-500">
                      异常 {draftIssueCount} 条
                    </div>
                  </div>
                  {hasDraftSelectionIssue && (
                    <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      当前选中草稿中有 {selectedDraftIssueCount} 条存在编号或内容问题，修正后才能导入。
                    </div>
                  )}
                  <div className="text-xs text-slate-500">
                    支持逐条修改标题、内容、关键词、优先级，再导入选中条款。
                  </div>
                </div>
                {visibleDrafts.length === 0 ? (
                  <div className="rounded-lg border border-blue-500/20 bg-slate-900/55 px-4 py-8 text-center text-sm text-slate-500">
                    当前筛选条件下没有草稿
                  </div>
                ) : visibleDrafts.map((draft, index) => {
                  const draftKey = domIdSegment(draft.id || `${draft.clauseCode}-${index}`)
                  const draftCheckboxId = `knowledge-draft-${draftKey}`
                  const draftKeywordsId = `knowledge-draft-keywords-${draftKey}`
                  const draftSourceId = `knowledge-draft-source-${draftKey}`
                  const draftPriorityId = `knowledge-draft-priority-${draftKey}`
                  return (
                  <div key={draft.id || `${draft.clauseCode}-${index}`} className={`rounded-lg border p-3 space-y-3 ${draftValidationMap.get(draft.id)?.hasIssue ? 'border-amber-400/35 bg-amber-500/5' : 'border-violet-400/20 bg-slate-900/60'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <label className="inline-flex items-start gap-2 min-w-0 flex-1" htmlFor={draftCheckboxId}>
                        <input
                          id={draftCheckboxId}
                          type="checkbox"
                          checked={selectedDraftIds.includes(draft.id)}
                          onChange={() => toggleDraft(draft.id)}
                          className="mt-1 h-4 w-4 rounded border-slate-500 bg-slate-900 text-violet-500 focus:ring-violet-400/40"
                          aria-label={`${selectedDraftIds.includes(draft.id) ? '取消选择' : '选择'}草稿《${draft.title || '未命名草稿'}》，编号 ${draft.clauseCode || '未编号'}，专业 ${profileNameMap.get(draft.profileId) || draft.profileId || '未记录'}，${draftValidationMap.get(draft.id)?.hasIssue ? `存在 ${draftValidationMap.get(draft.id)?.issues.length || 0} 个问题` : '校验通过'}`}
                        />
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-2">
                            <input
                              value={draft.clauseCode}
                              onChange={e => updateDraft(draft.id, 'clauseCode', e.target.value)}
                              aria-label={`草稿《${draft.title || '未命名草稿'}》的条款编号`}
                              className="rounded-lg border border-blue-500/25 bg-slate-950/70 px-3 py-2 text-xs text-violet-100 outline-none focus:border-blue-400/60"
                              placeholder="条款编号"
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="px-2 py-1 rounded text-xs border border-violet-400/30 bg-violet-500/10 text-violet-200">{profileNameMap.get(draft.profileId) || draft.profileId}</span>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`px-2 py-1 rounded text-xs border ${priorityClass[draft.priority] || priorityClass.中}`}>{draft.priority}优先级</span>
                          </div>
                          <input
                            value={draft.title}
                            onChange={e => updateDraft(draft.id, 'title', e.target.value)}
                            aria-label={`草稿《${draft.title || '未命名草稿'}》的标题`}
                            className="w-full rounded-lg border border-blue-500/25 bg-slate-950/70 px-3 py-2 text-sm text-blue-100 outline-none focus:border-blue-400/60"
                            placeholder="草稿标题"
                          />
                        </div>
                      </label>
                      <button
                        type="button"
                        onClick={() => removeDraft(draft.id)}
                        title={`删除草稿《${draft.title || '未命名草稿'}》`}
                        aria-label={`删除草稿《${draft.title || '未命名草稿'}》，编号 ${draft.clauseCode || '未编号'}`}
                        className="inline-flex items-center gap-1 text-red-300 hover:text-red-200 text-sm shrink-0"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                        删除
                      </button>
                    </div>
                    <textarea
                      value={draft.content}
                      onChange={e => updateDraft(draft.id, 'content', e.target.value)}
                      rows={4}
                      aria-label={`草稿《${draft.title || '未命名草稿'}》的内容`}
                      className="w-full rounded-lg border border-blue-500/25 bg-slate-950/70 px-3 py-2 text-sm text-slate-300 outline-none focus:border-blue-400/60 resize-none leading-6"
                      placeholder="草稿内容"
                    />
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <label className="block" htmlFor={draftKeywordsId}>
                        <span className="text-xs text-slate-400">关键词</span>
                        <textarea
                          id={draftKeywordsId}
                          value={(draft.keywords || []).join('；')}
                          onChange={e => updateDraft(draft.id, 'keywords', e.target.value)}
                          rows={3}
                          aria-label={`草稿《${draft.title || '未命名草稿'}》的关键词`}
                          className="mt-1 w-full rounded-lg border border-blue-500/25 bg-slate-950/70 px-3 py-2 text-sm text-slate-300 outline-none focus:border-blue-400/60 resize-none"
                          placeholder="多个关键词用逗号、分号、顿号或换行分隔"
                        />
                      </label>
                      <div className="space-y-3">
                        <label className="block" htmlFor={draftSourceId}>
                          <span className="text-xs text-slate-400">来源</span>
                          <input
                            id={draftSourceId}
                            value={draft.source}
                            onChange={e => updateDraft(draft.id, 'source', e.target.value)}
                            aria-label={`草稿《${draft.title || '未命名草稿'}》的来源`}
                            className="mt-1 w-full rounded-lg border border-blue-500/25 bg-slate-950/70 px-3 py-2 text-sm text-slate-300 outline-none focus:border-blue-400/60"
                            placeholder="来源文件"
                          />
                        </label>
                        <label className="block" htmlFor={draftPriorityId}>
                          <span className="text-xs text-slate-400">优先级</span>
                          <select
                            id={draftPriorityId}
                            value={draft.priority}
                            onChange={e => updateDraft(draft.id, 'priority', e.target.value)}
                            aria-label={`草稿《${draft.title || '未命名草稿'}》的优先级`}
                            className="mt-1 w-full rounded-lg border border-blue-500/25 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none focus:border-blue-400/60"
                          >
                            <option value="高">高</option>
                            <option value="中">中</option>
                            <option value="低">低</option>
                          </select>
                        </label>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(draft.keywords || []).map(keyword => (
                        <span key={`${draft.id}-${keyword}`} className="px-2 py-1 rounded text-xs border border-blue-400/20 bg-slate-950/60 text-slate-300">
                          {keyword}
                        </span>
                      ))}
                    </div>
                    {draftValidationMap.get(draft.id)?.hasIssue && (
                      <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 space-y-2">
                        <div>{draftValidationMap.get(draft.id).issues.join('；')}</div>
                        <button
                          type="button"
                          onClick={() => autoFixDraftCode(draft.id)}
                          title={`为草稿《${draft.title || '未命名草稿'}》自动建议编号`}
                          aria-label={`为草稿《${draft.title || '未命名草稿'}》自动建议编号`}
                          className="px-3 py-1.5 rounded-lg border border-amber-300/30 bg-amber-500/10 text-amber-100"
                        >
                          自动建议编号
                        </button>
                      </div>
                    )}
                    {Array.isArray(draft.matchedTerms) && draft.matchedTerms.length > 0 && (
                      <div className="text-xs text-slate-500">
                        命中术语：{draft.matchedTerms.join('、')}
                      </div>
                    )}
                  </div>
                )})}
                <button
                  type="button"
                  onClick={saveDrafts}
                  disabled={savingDrafts || selectedDraftIds.length === 0 || hasDraftSelectionIssue}
                  title={savingDrafts ? '正在导入选中草稿' : `导入选中草稿 ${selectedDraftIds.length} 条`}
                  aria-label={savingDrafts ? '正在导入选中草稿' : `导入选中草稿 ${selectedDraftIds.length} 条`}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm border border-emerald-300/40"
                >
                  <Save size={16} aria-hidden="true" />
                  {savingDrafts ? '导入中...' : `导入选中草稿${selectedDraftIds.length > 0 ? `（${selectedDraftIds.length}）` : ''}`}
                </button>
              </div>
            )}
          </div>
        </Panel>

        <Panel className="p-5">
          <h2 className="font-semibold text-blue-100 mb-4">{editingId ? '修改知识条款' : '新增知识条款'}</h2>
          <form onSubmit={saveItem} className="space-y-4">
            <label className="block" htmlFor={formProfileId}>
              <span className="text-sm text-slate-300">所属专业</span>
              <select id={formProfileId} value={form.profileId} onChange={e => updateForm('profileId', e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
                {profiles.map(profile => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-3">
            <label className="block" htmlFor={formClauseCodeId}>
              <span className="text-sm text-slate-300">条款编号</span>
              <input id={formClauseCodeId} value={form.clauseCode} onChange={e => updateForm('clauseCode', normalizeClauseCode(e.target.value))} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60" placeholder="如 INV-03" />
              {formClauseConflict && (
                <div className="mt-2 text-xs text-amber-300">该编号已被《{formClauseConflict.title}》占用，请更换。</div>
              )}
            </label>
              <label className="block" htmlFor={formPriorityId}>
                <span className="text-sm text-slate-300">优先级</span>
                <select id={formPriorityId} value={form.priority} onChange={e => updateForm('priority', e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
                  <option value="高">高</option>
                  <option value="中">中</option>
                  <option value="低">低</option>
                </select>
              </label>
            </div>
            <label className="block" htmlFor={formTitleId}>
              <span className="text-sm text-slate-300">条款标题</span>
              <input id={formTitleId} value={form.title} onChange={e => updateForm('title', e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60" placeholder="请输入条款标题" />
            </label>
            <label className="block" htmlFor={formSourceId}>
              <span className="text-sm text-slate-300">来源文件</span>
              <input id={formSourceId} value={form.source} onChange={e => updateForm('source', e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60" placeholder="如 投资测算审核指引" />
            </label>
            <label className="block" htmlFor={formContentId}>
              <span className="text-sm text-slate-300">条款内容</span>
              <textarea id={formContentId} value={form.content} onChange={e => updateForm('content', e.target.value)} rows={5} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none" placeholder="请输入条款内容" />
            </label>
            <label className="block" htmlFor={formKeywordsId}>
              <span className="text-sm text-slate-300">关键词</span>
              <textarea id={formKeywordsId} value={form.keywords} onChange={e => updateForm('keywords', e.target.value)} rows={3} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 resize-none" placeholder="多个关键词用逗号、分号、顿号或换行分隔" />
            </label>
            <label className="block" htmlFor={formStatusId}>
              <span className="text-sm text-slate-300">状态</span>
              <select id={formStatusId} value={form.status} onChange={e => updateForm('status', e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
                <option value="启用">启用</option>
                <option value="停用">停用</option>
              </select>
            </label>

            {error && <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
            {message && <div className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">{message}</div>}

            <div className="flex gap-2">
              <button type="submit" disabled={saving} className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm border border-blue-300/40">
                <Save size={16} aria-hidden="true" />
                {saving ? '保存中...' : '保存'}
              </button>
              {editingId && (
                <button type="button" onClick={resetForm} className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-blue-500/25 text-slate-300 text-sm">
                  <X size={16} aria-hidden="true" />
                  取消
                </button>
              )}
            </div>
          </form>
        </Panel>
      </aside>
    </div>
  )
}
