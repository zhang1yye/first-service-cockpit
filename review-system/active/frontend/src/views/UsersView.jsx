import { useEffect, useId, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Copy, Download, Edit3, ExternalLink, KeyRound, Plus, Power, Save, Search, ShieldAlert, ShieldCheck, Trash2, UsersRound, X, XCircle } from '../lib/lucide.js'
import { api, getUser } from '../lib/api'
import { copyText } from '../lib/clipboard'
import { csvCell } from '../lib/csv'
import Panel from '../components/Panel'
import CopyFallbackDialog from '../components/CopyFallbackDialog'

const emptyForm = {
  username: '',
  password: '',
  name: '',
  role: '使用者',
  department: '研发小组',
  status: '启用',
  mustChangePassword: true
}

const adminDefaultPasswordDeniedLogPath = '/logs?type=账号安全&result=拒绝&q=默认密码'

const permissionLabels = {
  submitProposal: '提交',
  reviewProposal: '审核',
  manageSystem: '系统',
  manageUsers: '人员',
  viewLogs: '日志'
}

function displayDateTime(value = '') {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
}

function permissionSummary(user = {}) {
  const permissions = Array.isArray(user.permissions) ? user.permissions : []
  return permissions.map(key => permissionLabels[key] || key).join('、') || '无权限'
}

function userHasPermission(user = {}, permission = '') {
  return Array.isArray(user.permissions) && user.permissions.includes(permission)
}

function canManageAccount(currentUser = {}, targetUser = {}) {
  if (currentUser.role === '管理员') return true
  if (targetUser.role === '管理员') return false
  const actorPermissions = Array.isArray(currentUser.permissions) ? currentUser.permissions : []
  const targetPermissions = Array.isArray(targetUser.permissions) ? targetUser.permissions : []
  return targetPermissions.every(permission => actorPermissions.includes(permission))
}

function userIsSubmitOnly(user = {}) {
  return userHasPermission(user, 'submitProposal') &&
    !userHasPermission(user, 'reviewProposal') &&
    !userHasPermission(user, 'manageSystem') &&
    !userHasPermission(user, 'manageUsers') &&
    !userHasPermission(user, 'viewLogs')
}

function permissionSetSummary(permissions = []) {
  const normalized = Array.isArray(permissions) ? permissions : []
  if (normalized.length === 0) return '无权限'
  if (
    normalized.includes('submitProposal') &&
    !normalized.includes('reviewProposal') &&
    !normalized.includes('manageSystem') &&
    !normalized.includes('manageUsers') &&
    !normalized.includes('viewLogs')
  ) return '仅提交'
  return normalized.map(key => permissionLabels[key] || key).join('、')
}

function permissionCapabilityTags(permissions = []) {
  const normalized = Array.isArray(permissions) ? permissions : []
  if (normalized.length === 0) return ['无权限']
  if (permissionSetSummary(normalized) === '仅提交') return ['仅提交']

  const tags = []
  if (normalized.includes('submitProposal')) tags.push('可提交')
  if (normalized.includes('reviewProposal')) tags.push('可审核')
  if (normalized.includes('viewLogs')) tags.push('可看日志')
  if (normalized.includes('manageUsers')) tags.push('可管人员')
  if (normalized.includes('manageSystem')) tags.push('可管系统')
  return tags
}

function permissionFilterText(permission = '全部') {
  if (!permission || permission === '全部') return '全部'
  if (permission === 'submitOnly') return '仅提交'
  const label = permissionLabels[permission] || permission
  const tags = permissionCapabilityTags([permission]).filter(tag => tag !== '无权限')
  return tags.length ? `${label}（${tags.join('、')}）` : label
}

function capabilityTagClass(tag = '') {
  if (tag === '仅提交') return 'border-slate-400/25 bg-slate-500/10 text-slate-200'
  if (tag === '可审核') return 'border-cyan-400/25 bg-cyan-500/10 text-cyan-100'
  if (tag === '可看日志') return 'border-violet-400/25 bg-violet-500/10 text-violet-100'
  if (tag === '可管人员') return 'border-blue-400/25 bg-blue-500/10 text-blue-100'
  if (tag === '可管系统') return 'border-amber-400/25 bg-amber-500/10 text-amber-100'
  if (tag === '无权限') return 'border-red-400/25 bg-red-500/10 text-red-100'
  return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
}

function riskBadgeClass(tone = '') {
  if (tone === 'red') return 'border-red-400/25 bg-red-500/10 text-red-100'
  if (tone === 'amber') return 'border-amber-400/25 bg-amber-500/10 text-amber-100'
  if (tone === 'rose') return 'border-rose-400/25 bg-rose-500/10 text-rose-100'
  if (tone === 'sky') return 'border-sky-400/25 bg-sky-500/10 text-sky-100'
  if (tone === 'violet') return 'border-violet-400/25 bg-violet-500/10 text-violet-100'
  if (tone === 'orange') return 'border-orange-400/25 bg-orange-500/10 text-orange-100'
  if (tone === 'slate') return 'border-slate-400/25 bg-slate-500/10 text-slate-200'
  return 'border-blue-400/25 bg-blue-500/10 text-blue-100'
}

function messageActionClass(action = {}) {
  if (action.actionKey === 'disable') return 'border-red-300/30 bg-red-500/10 text-red-100 hover:border-red-200/60'
  if (action.actionKey === 'requirePasswordChange') return 'border-amber-300/30 bg-amber-500/10 text-amber-100 hover:border-amber-200/60'
  if (action.actionKey === 'unlockLogin') return 'border-orange-300/30 bg-orange-500/10 text-orange-100 hover:border-orange-200/60'
  if (action.label?.includes('通知')) return 'border-blue-300/30 bg-blue-500/10 text-blue-100 hover:border-blue-200/60'
  return 'border-emerald-300/30 bg-slate-950/25 text-emerald-100 hover:border-emerald-200/60'
}

function messageActionIcon(action = {}) {
  if (action.actionKey === 'disable') return Power
  if (action.actionKey === 'requirePasswordChange') return KeyRound
  if (action.actionKey === 'unlockLogin') return ShieldCheck
  if (action.label?.includes('通知')) return Copy
  return ExternalLink
}

function userNeedsPasswordChange(user = {}) {
  return user.role !== '管理员' && user.mustChangePassword === true
}

function userPasswordStatusText(user = {}) {
  if (user.usesDefaultPassword) return '默认密码'
  if (userNeedsPasswordChange(user)) return '需改密'
  return '正常'
}

function MetricFilterButton({ label, value, hint, title, ariaLabel, tone = 'blue', onClick }) {
  const toneClass = {
    blue: 'border-blue-500/20 text-blue-300',
    emerald: 'border-emerald-500/20 text-emerald-300',
    slate: 'border-slate-500/20 text-slate-400',
    amber: 'border-amber-500/20 text-orange-300',
    red: 'border-red-500/20 text-red-300',
    violet: 'border-violet-500/20 text-violet-300',
    rose: 'border-rose-500/20 text-rose-300',
    sky: 'border-sky-500/20 text-sky-300',
    orange: 'border-orange-500/20 text-orange-300',
    cyan: 'border-cyan-500/20 text-cyan-300'
  }[tone] || 'border-blue-500/20 text-blue-300'

  const valueClass = {
    blue: 'text-blue-200',
    emerald: 'text-emerald-200',
    slate: 'text-slate-200',
    amber: 'text-orange-200',
    red: 'text-red-200',
    violet: 'text-violet-200',
    rose: 'text-rose-200',
    sky: 'text-sky-200',
    orange: 'text-orange-200',
    cyan: 'text-cyan-200'
  }[tone] || 'text-blue-200'

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel || title}
      className={`rounded-lg border bg-slate-900/60 p-4 text-left transition hover:-translate-y-0.5 hover:border-white/25 ${toneClass}`}
    >
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-2 text-2xl font-bold ${valueClass}`}>{value}</div>
      <div className="mt-2 text-xs">{hint}</div>
    </button>
  )
}

function roleBoundaryText(role = '使用者', permissions = []) {
  const normalizedRole = role === '管理员' ? '管理员' : '使用者'
  const permissionText = permissionSetSummary(permissions)
  if (normalizedRole === '管理员') {
    return `管理员账号：保留系统和人员管理能力，不强制下次登录改密；当前权限 ${permissionText}。`
  }
  return `${role || '使用者'}账号：按角色权限矩阵生效，可要求下次登录改密；当前权限 ${permissionText}。`
}

function passwordActionAdvice(user = {}) {
  if (user.usesDefaultPassword && user.role === '管理员') return '请在人员管理中为管理员设置非默认强密码'
  if (user.usesDefaultPassword) return '请重置密码并要求下次登录修改'
  if (userNeedsPasswordChange(user)) return '等待使用者下次登录完成改密'
  if (user.loginLocked) return '如确认本人操作，可解除登录锁定'
  return '无需处理'
}

export default function UsersView() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const currentUser = getUser()
  const isAdministrator = currentUser?.role === '管理员'
  const nameInputId = useId()
  const usernameInputId = useId()
  const passwordInputId = useId()
  const passwordRulesId = useId()
  const formErrorId = useId()
  const roleSelectId = useId()
  const departmentInputId = useId()
  const statusSelectId = useId()
  const mustChangePasswordId = useId()
  const [users, setUsers] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [actingId, setActingId] = useState('')
  const [selectedIds, setSelectedIds] = useState([])
  const [userConfig, setUserConfig] = useState({ inactiveLoginThresholdDays: 30, sharedLoginIpAccountThreshold: 3, trustedLoginIpCount: 0, latestPasswordNotice: null })
  const [rolePermissions, setRolePermissions] = useState({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [lastExportAuditId, setLastExportAuditId] = useState('')
  const [lastBulkAuditQuery, setLastBulkAuditQuery] = useState('')
  const [lastNoticeAuditQuery, setLastNoticeAuditQuery] = useState('')
  const [lastRiskSelectionType, setLastRiskSelectionType] = useState('')
  const [copyFallback, setCopyFallback] = useState({ open: false, title: '', description: '', content: '' })
  const userMessageActions = useMemo(() => {
    if (!message) return []
    const shouldShowSecurityLog = [
      '账号',
      '密码',
      '登录锁定',
      '可信白名单',
      '批量处理',
      '安全清单'
    ].some(keyword => message.includes(keyword))
    const actions = shouldShowSecurityLog
      ? [
          { label: '查看安全统计', to: '/stats?focus=security', hint: '跳转到账号安全统计页' },
          { label: '查看账号安全日志', to: '/logs?type=账号安全&range=近30天', hint: '跳转到近 30 天账号安全日志' }
        ]
      : []
    if (lastExportAuditId && message.includes(lastExportAuditId)) {
      actions.unshift({ label: '查看本批导出日志', to: `/logs?type=账号安全&q=${encodeURIComponent(lastExportAuditId)}`, hint: '按本次导出批次筛选日志' })
    }
    if (lastBulkAuditQuery && message.includes('批量处理')) {
      actions.unshift({ label: '查看本次批量日志', to: `/logs?type=账号安全&q=${encodeURIComponent(lastBulkAuditQuery)}`, hint: '按本次批量处理批次筛选日志' })
    }
    if (lastNoticeAuditQuery && message.includes('通知文案')) {
      actions.unshift({ label: '查看文案生成留痕', to: `/logs?type=账号安全&q=${encodeURIComponent(lastNoticeAuditQuery)}`, hint: '按本次通知文案生成留痕筛选日志' })
    }
    const passwordNoticeReady = (
      message.includes('下次登录修改密码') ||
      message.includes('下次登录必须修改密码') ||
      message.includes('可继续生成改密通知文案')
    ) && !message.includes('通知文案') && !message.includes('改密通知')
    if (passwordNoticeReady) {
      actions.unshift({ label: '准备改密通知文案', to: '/users?password=需改密&select=visible', hint: '筛选需改密账号并自动选择当前结果，不会发送' })
    }
    const riskSelectionMessageReady = /^已选择 \d+ 个/.test(message)
    if (riskSelectionMessageReady && ['defaultPassword', 'defaultPasswordUsers'].includes(lastRiskSelectionType)) {
      actions.unshift({ label: '批量要求改密', actionKey: 'requirePasswordChange', hint: '会打开二次确认，不会直接执行' })
    }
    if (riskSelectionMessageReady && lastRiskSelectionType === 'inactiveLogin') {
      actions.unshift({ label: '批量停用', actionKey: 'disable', hint: '会打开二次确认，不会直接执行' })
    }
    if (riskSelectionMessageReady && lastRiskSelectionType === 'loginLocked') {
      actions.unshift({ label: '批量解锁', actionKey: 'unlockLogin', hint: '会打开二次确认，不会直接执行' })
    }
    return actions
  }, [lastBulkAuditQuery, lastExportAuditId, lastNoticeAuditQuery, lastRiskSelectionType, message])

  const loadUsers = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.get('/users')
      setUsers(data.users || [])
      setUserConfig(prev => ({ ...prev, ...(data.config || {}) }))
      setRolePermissions(data.rolePermissions || {})
    } catch (err) {
      setError(err.message || '人员加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadUsers()
  }, [])

  const statusFilter = searchParams.get('status') || '全部'
  const passwordFilter = searchParams.get('password') || '全部'
  const roleFilter = searchParams.get('role') || '全部'
  const loginFilter = searchParams.get('login') || '全部'
  const ipFilter = searchParams.get('ip') || '全部'
  const securityFilter = searchParams.get('security') || '全部'
  const permissionFilter = searchParams.get('permission') || '全部'
  const noticeFilter = searchParams.get('notice') || ''
  const autoSelectMode = searchParams.get('select') || ''
  const keyword = searchParams.get('q') || ''
  const normalizedKeyword = keyword.trim().toLowerCase()
  const activeFilterTags = [
    statusFilter !== '全部' ? { label: '状态', value: statusFilter, tone: 'blue' } : null,
    roleFilter !== '全部' ? { label: '角色', value: roleFilter, tone: 'sky' } : null,
    passwordFilter !== '全部' ? { label: '密码', value: passwordFilter, tone: passwordFilter === '默认密码' ? 'red' : 'amber' } : null,
    loginFilter !== '全部' ? { label: '登录', value: loginFilter, tone: loginFilter === '长期未登录' ? 'rose' : 'slate' } : null,
    ipFilter !== '全部' ? { label: '登录 IP', value: ipFilter, tone: ipFilter === '同IP多账号' ? 'sky' : 'slate' } : null,
    securityFilter !== '全部' ? { label: '安全', value: securityFilter, tone: 'orange' } : null,
    permissionFilter !== '全部' ? { label: '权限', value: permissionFilterText(permissionFilter), tone: 'blue' } : null,
    noticeFilter === 'latest' ? { label: '文案', value: '最近生成文案涉及账号', tone: 'amber' } : null,
    keyword.trim() ? { label: '关键词', value: keyword.trim(), tone: 'slate' } : null
  ].filter(Boolean)
  const latestNoticeUsernames = useMemo(() => (
    Array.isArray(userConfig.latestPasswordNotice?.targetUsernames)
      ? userConfig.latestPasswordNotice.targetUsernames.map(username => String(username || '').trim()).filter(Boolean)
      : []
  ), [userConfig.latestPasswordNotice])
  const latestNoticeUsernameSet = useMemo(() => new Set(latestNoticeUsernames), [latestNoticeUsernames])

  const filteredUsers = useMemo(() => (
    users.filter(user => {
      const searchable = [user.name, user.username, user.role, permissionSummary(user), user.department, user.status, user.lastLoginAt, user.lastLoginIp, user.loginRisk]
        .join(' ')
        .toLowerCase()
      const passwordMatched = (
        passwordFilter === '全部' ||
        (passwordFilter === '需改密' && userNeedsPasswordChange(user)) ||
        (passwordFilter === '默认密码' && user.usesDefaultPassword) ||
        (passwordFilter === '正常' && userPasswordStatusText(user) === '正常')
      )
      return (
        (statusFilter === '全部' || user.status === statusFilter) &&
        passwordMatched &&
        (roleFilter === '全部' || user.role === roleFilter) &&
        (loginFilter === '全部' || user.loginRisk === loginFilter) &&
        (ipFilter === '全部' ||
          (ipFilter === '同IP多账号' && !user.trustedLoginIp && user.sameLoginIpAccountCount >= (user.sharedLoginIpAccountThreshold || 3)) ||
          (ipFilter === '可信IP' && user.trustedLoginIp)) &&
        (securityFilter === '全部' || (securityFilter === '登录锁定' && user.loginLocked)) &&
        (noticeFilter !== 'latest' || latestNoticeUsernameSet.has(String(user.username || '').trim())) &&
        (permissionFilter === '全部' ||
          (permissionFilter === 'submitOnly' ? userIsSubmitOnly(user) : userHasPermission(user, permissionFilter))) &&
        (!normalizedKeyword || searchable.includes(normalizedKeyword))
      )
    })
  ), [ipFilter, latestNoticeUsernameSet, loginFilter, normalizedKeyword, noticeFilter, passwordFilter, permissionFilter, roleFilter, securityFilter, statusFilter, users])
  const visibleIds = useMemo(
    () => filteredUsers.filter(user => canManageAccount(currentUser, user)).map(user => user.id),
    [currentUser, filteredUsers]
  )
  const selectedUsers = useMemo(
    () => users.filter(user => selectedIds.includes(user.id) && canManageAccount(currentUser, user)),
    [currentUser, selectedIds, users]
  )
  const exportTargetUsers = selectedUsers.length > 0 ? selectedUsers : filteredUsers
  const exportScope = selectedUsers.length > 0 ? '已选账号' : '当前筛选结果'
  const exportButtonLabel = selectedUsers.length > 0
    ? `导出已选 ${selectedUsers.length}`
    : `导出清单 ${filteredUsers.length}`
  const exportDisabled = exporting || exportTargetUsers.length === 0
  const selectedVisibleCount = visibleIds.filter(id => selectedIds.includes(id)).length
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length
  const visibleSelectionActionText = allVisibleSelected ? '取消选择当前列表' : '选择当前列表'
  const userTableColumns = [
    { label: '姓名', title: '账号显示姓名' },
    { label: '账号', title: '登录用户名' },
    { label: '角色', title: '账号所属角色和授权边界' },
    { label: '权限范围', title: '该账号实际具备的提交、审核、日志、人员或系统权限' },
    { label: '部门', title: '账号所属部门或小组' },
    { label: '状态', title: '账号启用或停用状态' },
    { label: '密码状态', title: '默认密码、需改密或正常状态' },
    { label: '最近登录', title: '最近登录时间、登录风险和登录 IP 信息' },
    { label: '创建时间', title: '账号创建时间' },
    { label: '操作', title: '编辑、状态、密码和安全操作' }
  ]
  const activeFilterSummaryText = activeFilterTags.length
    ? activeFilterTags.map(item => `${item.label}：${item.value}`).join('；')
    : '全部账号'

  useEffect(() => {
    if (autoSelectMode !== 'visible' || loading) return

    setSelectedIds(visibleIds)
    setMessage(visibleIds.length
      ? `已自动选择 ${visibleIds.length} 个账号（${activeFilterSummaryText}），可继续批量处理`
      : `当前筛选下没有可选择账号（${activeFilterSummaryText}）`)
    setError('')
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('select')
      return next
    })
  }, [activeFilterSummaryText, autoSelectMode, loading, setSearchParams, visibleIds])

  const rolePermissionMap = useMemo(() => {
    const map = { ...rolePermissions }
    users.forEach(user => {
      if (!map[user.role] && Array.isArray(user.permissions)) map[user.role] = user.permissions
    })
    return map
  }, [rolePermissions, users])
  const roleOptions = useMemo(() => {
    const preferred = ['管理员', '使用者', '审核员', '提交人', '观察员']
    const discovered = Object.keys(rolePermissionMap)
    return [
      ...preferred.filter(role => discovered.includes(role) || role === '管理员' || role === '使用者'),
      ...discovered.filter(role => !preferred.includes(role))
    ]
  }, [rolePermissionMap])
  const currentPermissions = Array.isArray(currentUser?.permissions) ? currentUser.permissions : []
  const editableRoleOptions = isAdministrator
    ? roleOptions
    : roleOptions.filter(role => role !== '管理员' && (rolePermissionMap[role] || []).every(permission => currentPermissions.includes(permission)))
  const editingUser = users.find(user => user.id === editingId)
  const editingSelf = Boolean(editingUser && currentUser?.username && editingUser.username.trim().toLowerCase() === currentUser.username.trim().toLowerCase())
  const formRolePermissions = rolePermissionMap[form.role] || []
  const formRoleCapabilityTags = permissionCapabilityTags(formRolePermissions)
  const formRoleBoundaryText = roleBoundaryText(form.role, formRolePermissions)

  const updateForm = (key, value) => {
    setForm(prev => ({
      ...prev,
      [key]: value,
      ...(key === 'role' && value === '管理员' ? { mustChangePassword: false } : {}),
      ...(key === 'role' && value !== '管理员' ? { password: '' } : {})
    }))
  }

  const enabledCount = users.filter(user => user.status === '启用').length
  const disabledCount = users.filter(user => user.status !== '启用').length
  const adminCount = users.filter(user => user.role === '管理员' && user.status === '启用').length
  const roleSummaries = roleOptions.map(role => ({
    role,
    enabled: users.filter(user => user.role === role && user.status === '启用').length,
    total: users.filter(user => user.role === role).length
  }))
  const mustChangePasswordCount = users.filter(userNeedsPasswordChange).length
  const defaultPasswordCount = users.filter(user => user.usesDefaultPassword).length
  const defaultPasswordUserCount = users.filter(user => user.usesDefaultPassword && user.role !== '管理员').length
  const defaultPasswordAdminCount = users.filter(user => user.usesDefaultPassword && user.role === '管理员').length
  const neverLoginCount = users.filter(user => !user.lastLoginAt).length
  const inactiveLoginCount = users.filter(user => user.loginRisk === '长期未登录').length
  const sharedLoginIpAccountThreshold = userConfig.sharedLoginIpAccountThreshold || 3
  const sharedLoginIpCount = users.filter(user => !user.trustedLoginIp && user.sameLoginIpAccountCount >= sharedLoginIpAccountThreshold).length
  const trustedLoginIpCount = userConfig.trustedLoginIpCount || 0
  const trustedLoginIpAccountCount = users.filter(user => user.trustedLoginIp).length
  const loginLockedCount = users.filter(user => user.loginLocked).length
  const manageSystemCount = users.filter(user => userHasPermission(user, 'manageSystem')).length
  const manageUsersCount = users.filter(user => userHasPermission(user, 'manageUsers')).length
  const submitProposalCount = users.filter(user => userHasPermission(user, 'submitProposal')).length
  const reviewProposalCount = users.filter(user => userHasPermission(user, 'reviewProposal')).length
  const viewLogsCount = users.filter(user => userHasPermission(user, 'viewLogs')).length
  const submitOnlyCount = users.filter(userIsSubmitOnly).length
  const inactiveLoginThresholdDays = userConfig.inactiveLoginThresholdDays || 30
  const selectedActiveAdminCount = selectedUsers.filter(user => user.role === '管理员' && user.status === '启用').length
  const bulkDisableWouldRemoveAllAdmins = selectedUsers.length > 0 && adminCount > 0 && selectedActiveAdminCount >= adminCount
  const selectedRiskSummary = {
    admins: selectedUsers.filter(user => user.role === '管理员').length,
    activeAdmins: selectedActiveAdminCount,
    disabled: selectedUsers.filter(user => user.status === '停用').length,
    requirePasswordChangeEligible: selectedUsers.filter(user => user.role !== '管理员' && !userNeedsPasswordChange(user)).length,
    requirePasswordChangeSkipped: selectedUsers.filter(user => user.role === '管理员' || userNeedsPasswordChange(user)).length,
    defaultPassword: selectedUsers.filter(user => user.usesDefaultPassword).length,
    neverLogin: selectedUsers.filter(user => !user.lastLoginAt).length,
    inactiveLogin: selectedUsers.filter(user => user.loginRisk === '长期未登录').length,
    sharedLoginIp: selectedUsers.filter(user => !user.trustedLoginIp && user.sameLoginIpAccountCount >= sharedLoginIpAccountThreshold).length,
    loginLocked: selectedUsers.filter(user => user.loginLocked).length,
    canSubmit: selectedUsers.filter(user => userHasPermission(user, 'submitProposal')).length,
    canReview: selectedUsers.filter(user => userHasPermission(user, 'reviewProposal')).length,
    canViewLogs: selectedUsers.filter(user => userHasPermission(user, 'viewLogs')).length,
    canManageUsers: selectedUsers.filter(user => userHasPermission(user, 'manageUsers')).length,
    canManageSystem: selectedUsers.filter(user => userHasPermission(user, 'manageSystem')).length
  }
  const selectedScopeBadges = [
    { label: '管理员', value: selectedRiskSummary.admins, tone: 'sky' },
    { label: '启用管理员', value: selectedRiskSummary.activeAdmins, tone: 'blue' },
    { label: '已停用', value: selectedRiskSummary.disabled, tone: 'slate' },
    { label: '改密将跳过', value: selectedRiskSummary.requirePasswordChangeSkipped, tone: 'amber' }
  ]
  const selectedCapabilitySummary = [
    { label: '可提交', value: selectedRiskSummary.canSubmit },
    { label: '可审核', value: selectedRiskSummary.canReview },
    { label: '可看日志', value: selectedRiskSummary.canViewLogs },
    { label: '可管人员', value: selectedRiskSummary.canManageUsers },
    { label: '可管系统', value: selectedRiskSummary.canManageSystem }
  ]
  const selectedRiskBadges = [
    { label: '默认密码', value: selectedRiskSummary.defaultPassword, tone: 'red' },
    { label: '需改密可处理', value: selectedRiskSummary.requirePasswordChangeEligible, tone: 'amber' },
    { label: '从未登录', value: selectedRiskSummary.neverLogin, tone: 'violet' },
    { label: '长期未登录', value: selectedRiskSummary.inactiveLogin, tone: 'rose' },
    { label: '同 IP 多账号', value: selectedRiskSummary.sharedLoginIp, tone: 'sky' },
    { label: '登录锁定', value: selectedRiskSummary.loginLocked, tone: 'orange' }
  ]
  const selectedMustChangePasswordUsers = selectedUsers.filter(userNeedsPasswordChange)
  const passwordChangeNoticeUsers = selectedMustChangePasswordUsers.length > 0
    ? selectedMustChangePasswordUsers
    : users.filter(userNeedsPasswordChange)
  const selectedPasswordChangeNoticeOnly = selectedMustChangePasswordUsers.length > 0 && selectedRiskSummary.requirePasswordChangeEligible === 0
  const bulkActionHints = selectedUsers.length > 0
    ? [
        selectedRiskSummary.requirePasswordChangeEligible === 0
          ? { label: '批量要求改密不可用', text: '当前选择中没有可要求改密的非管理员账号。', tone: 'amber', actionKey: 'selectDefaultPasswordUsers', actionLabel: '选择可改密账号' }
          : null,
        bulkDisableWouldRemoveAllAdmins
          ? { label: '批量停用已阻止', text: '当前选择会停用全部启用管理员，请至少保留 1 个启用管理员。', tone: 'red', actionKey: 'removeActiveAdmins', actionLabel: '移除启用管理员' }
          : null,
        selectedRiskSummary.loginLocked === 0
          ? { label: '批量解锁不可用', text: '当前选择中没有登录锁定账号。', tone: 'orange', actionKey: 'selectLoginLocked', actionLabel: '选择锁定账号' }
          : null
      ].filter(Boolean)
    : []
  const passwordTouched = Boolean(form.password)
  const passwordChecks = [
    { key: 'length', label: '至少 8 位', passed: form.password.length >= 8 },
    { key: 'letter', label: '包含字母', passed: /[A-Za-z]/.test(form.password) },
    { key: 'number', label: '包含数字', passed: /\d/.test(form.password) }
  ]
  const adminPasswordRequired = !editingId && form.role === '管理员'
  const passwordValid = (!passwordTouched && !adminPasswordRequired) || passwordChecks.every(item => item.passed)
  const failedPasswordChecks = passwordTouched ? passwordChecks.filter(item => !item.passed) : []
  const normalizedUsername = form.username.trim()
  const normalizedName = form.name.trim()
  const normalizedDepartment = form.department.trim()
  const profileValid = normalizedUsername.length >= 2 && normalizedName.length >= 2 && Boolean(normalizedDepartment)
  const formValid = profileValid && passwordValid
  const formSaveBlockedReason = normalizedName.length < 2
    ? '保存被阻止：姓名去除首尾空格后不能少于 2 个字符。'
    : normalizedUsername.length < 2
      ? '保存被阻止：账号去除首尾空格后不能少于 2 个字符。'
      : !normalizedDepartment
        ? '保存被阻止：部门不能为空或仅包含空格。'
        : !passwordValid
          ? adminPasswordRequired && !passwordTouched
            ? '保存被阻止：管理员账号必须设置非默认强密码。'
            : `保存被阻止：密码${failedPasswordChecks.length ? `未通过“${failedPasswordChecks.map(item => item.label).join('、')}”校验` : '未通过强度校验'}。`
          : ''
  const formSaveImpactBadges = [
    { label: '角色', value: form.role || '未选择', tone: form.role === '管理员' ? 'amber' : 'blue' },
    { label: '状态', value: form.status || '启用', tone: form.status === '启用' ? 'sky' : 'slate' },
    {
      label: '密码',
      value: form.role !== '管理员' && !editingId ? '服务端生成一次性临时密码' : passwordTouched ? '将写入管理员新密码' : '保持不变',
      tone: passwordTouched ? 'amber' : 'slate'
    },
    {
      label: '登录改密',
      value: form.role === '管理员' ? '管理员不强制改密' : form.mustChangePassword ? '下次登录必须修改' : '不强制',
      tone: form.role === '管理员' ? 'slate' : form.mustChangePassword ? 'amber' : 'blue'
    },
    { label: '权限', value: permissionSetSummary(formRolePermissions), tone: formRolePermissions.length ? 'blue' : 'red' }
  ]

  const setStatusFilter = (value) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === '全部') next.delete('status')
      else next.set('status', value)
      return next
    })
  }

  const setPasswordFilter = (value) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === '全部') next.delete('password')
      else next.set('password', value)
      return next
    })
  }

  const setRoleFilter = (value, status = '') => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === '全部') next.delete('role')
      else next.set('role', value)
      if (status) next.set('status', status)
      return next
    })
  }

  const setLoginFilter = (value) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === '全部') next.delete('login')
      else next.set('login', value)
      return next
    })
  }

  const setIpFilter = (value) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === '全部') next.delete('ip')
      else next.set('ip', value)
      return next
    })
  }

  const setSecurityFilter = (value) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === '全部') next.delete('security')
      else next.set('security', value)
      return next
    })
  }

  const setPermissionFilter = (value) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value || value === '全部') next.delete('permission')
      else next.set('permission', value)
      return next
    })
  }

  const setKeyword = (value) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (!value.trim()) next.delete('q')
      else next.set('q', value)
      return next
    })
  }

  const clearFilters = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('status')
      next.delete('password')
      next.delete('role')
      next.delete('login')
      next.delete('ip')
      next.delete('security')
      next.delete('permission')
      next.delete('notice')
      next.delete('q')
      return next
    })
  }

  const resetForm = () => {
    setForm(emptyForm)
    setEditingId('')
    setError('')
    setMessage('')
    setLastRiskSelectionType('')
  }

  const startCreateUser = ({ resetFilters = false } = {}) => {
    resetForm()
    if (resetFilters) {
      clearFilters()
      setMessage('已清除筛选并切换到新增账号表单，保存后可在列表中查看新账号')
    }
  }

  const toggleSelectUser = (user = {}) => {
    const id = user.id
    const label = user.name || user.username || '该账号'
    const username = user.username ? `（${user.username}）` : ''
    const willSelect = !selectedIds.includes(id)
    setSelectedIds(prev => willSelect ? [...prev, id] : prev.filter(item => item !== id))
    setLastRiskSelectionType('')
    setMessage(willSelect ? `已选择账号：${label}${username}` : `已取消选择账号：${label}${username}`)
    setError('')
  }

  const toggleSelectVisible = () => {
    const willClearVisible = allVisibleSelected
    setSelectedIds(prev => {
      if (willClearVisible) return prev.filter(id => !visibleIds.includes(id))
      return [...new Set([...prev, ...visibleIds])]
    })
    setMessage(willClearVisible
      ? `已取消选择当前列表 ${visibleIds.length} 个账号（${activeFilterSummaryText}）`
      : `已选择当前列表 ${visibleIds.length} 个账号（${activeFilterSummaryText}），可继续批量处理`)
    setLastRiskSelectionType('')
    setError('')
  }

  const clearSelectedUsers = () => {
    const clearedCount = selectedUsers.length
    setSelectedIds([])
    setLastRiskSelectionType('')
    setMessage(clearedCount ? `已清空 ${clearedCount} 个已选账号` : '当前没有已选账号')
    setError('')
  }

  const selectRiskUsers = (riskType) => {
    const riskSelectionMeta = {
      defaultPassword: { label: '默认密码风险账号', next: '可继续重置密码或批量要求改密' },
      defaultPasswordUsers: { label: '默认密码使用者账号', next: '可继续批量要求改密；管理员需单独设置非默认强密码' },
      neverLogin: { label: '从未登录账号', next: '可核对是否仍需保留账号' },
      inactiveLogin: { label: '长期未登录账号', next: '可结合业务情况批量停用' },
      sharedLoginIp: { label: '同 IP 多账号', next: '可核查是否存在共用账号或代登录' },
      loginLocked: { label: '登录锁定账号', next: '确认本人操作后可批量解锁' }
    }
    const riskUsers = users.filter(user => {
      if (!canManageAccount(currentUser, user)) return false
      if (riskType === 'defaultPassword') return user.usesDefaultPassword
      if (riskType === 'defaultPasswordUsers') return user.usesDefaultPassword && user.role !== '管理员'
      if (riskType === 'neverLogin') return !user.lastLoginAt
      if (riskType === 'inactiveLogin') return user.loginRisk === '长期未登录'
      if (riskType === 'sharedLoginIp') return !user.trustedLoginIp && user.sameLoginIpAccountCount >= sharedLoginIpAccountThreshold
      if (riskType === 'loginLocked') return user.loginLocked
      return false
    })
    setSelectedIds(riskUsers.map(user => user.id))
    setLastRiskSelectionType(riskType)
    const meta = riskSelectionMeta[riskType] || { label: '风险账号', next: '可继续批量处理' }
    setMessage(riskUsers.length ? `已选择 ${riskUsers.length} 个${meta.label}，${meta.next}` : `当前没有符合条件的${meta.label}`)
    setError('')
  }

  const runMessageAction = (action) => {
    if (action.actionKey) return runBulkAction(action.actionKey)
    if (action.to) return navigate(action.to)
  }

  const runBulkHintAction = (actionKey) => {
    if (actionKey === 'selectDefaultPasswordUsers') return selectRiskUsers('defaultPasswordUsers')
    if (actionKey === 'selectLoginLocked') return selectRiskUsers('loginLocked')
    if (actionKey === 'removeActiveAdmins') {
      const safeSelectedUsers = selectedUsers.filter(user => !(user.role === '管理员' && user.status === '启用'))
      setSelectedIds(safeSelectedUsers.map(user => user.id))
      setMessage(safeSelectedUsers.length
        ? `已从选择中移除启用管理员，剩余 ${safeSelectedUsers.length} 个账号可继续处理`
        : '已移除启用管理员，当前没有可批量停用的账号')
      setError('')
    }
  }

  const passwordChangeNoticeText = (targetUsers = []) => {
    const loginUrl = `${window.location.origin}/login?reason=password-required`
    const accountLines = targetUsers
      .map((user, index) => `${index + 1}. ${user.name || user.username}（账号：${user.username}）`)
      .join('\n')

    return [
      '账号改密通知文案（未发送）',
      '',
      '你的第一服务研发小组审核系统账号需要完成首次或重置后密码修改。',
      `登录地址：${loginUrl}`,
      '',
      '处理步骤：',
      '1. 使用当前账号和现有密码登录系统。',
      '2. 系统会自动进入“修改密码”页面。',
      '3. 设置至少 8 位、同时包含字母和数字的新密码，且不要使用系统默认密码。',
      '4. 修改成功后即可进入系统。',
      '',
      '需处理账号：',
      accountLines || '暂无',
      '',
      '如忘记当前密码，请联系管理员在人员管理中重置。'
    ].join('\n')
  }

  const copyPasswordChangeNotice = async () => {
    const content = passwordChangeNoticeText(passwordChangeNoticeUsers)
    const auditNotice = async () => {
      const data = await api.post('/users/password-change-notice-audit', {
        ids: passwordChangeNoticeUsers.map(user => user.id),
        source: selectedMustChangePasswordUsers.length > 0 ? '已选账号' : '全部需改密账号'
      })
      setLastNoticeAuditQuery(data.auditId || data.auditKeyword || '生成账号改密通知文案')
      if (data.auditId) {
        setUserConfig(prev => ({
          ...prev,
          latestPasswordNotice: {
            ...(prev.latestPasswordNotice || {}),
            auditId: data.auditId,
            noticeCount: data.affectedAccountCount ?? data.count ?? 0,
            affectedAccountCount: data.affectedAccountCount ?? data.count ?? 0,
            sentCount: 0,
            deliveryStatus: '未发送',
            at: new Date().toLocaleString('zh-CN', { hour12: false }),
            noticeChannel: '复制通知文案',
            targetUsernames: passwordChangeNoticeUsers.map(user => user.username),
            targetNames: passwordChangeNoticeUsers.map(user => user.name || user.username)
          }
        }))
      }
      return data
    }

    try {
      await copyText(content)
      let auditData = null
      let auditError = ''
      try {
        auditData = await auditNotice()
      } catch (err) {
        auditError = err.message || '改密通知文案留痕写入失败'
      }
      setMessage(`已复制 ${passwordChangeNoticeUsers.length} 个需改密账号的通知文案（未发送）${auditData?.auditId ? `，留痕 ${auditData.auditId}` : ''}`)
      setError(auditError ? `通知文案已复制，但操作留痕未写入：${auditError}` : '')
    } catch {
      let auditData = null
      let auditError = ''
      try {
        auditData = await auditNotice()
      } catch (err) {
        auditError = err.message || '改密通知文案留痕写入失败'
      }
      setCopyFallback({
        open: true,
        title: '复制改密通知文案（未发送）',
        description: '当前浏览器未开放剪贴板权限，已为你展开可手动复制内容。',
        content
      })
      setMessage(`改密通知文案已生成（未发送），请从弹窗手动复制${auditData?.auditId ? `，留痕 ${auditData.auditId}` : ''}`)
      setError(auditError ? `通知文案已生成，但操作留痕未写入：${auditError}` : '')
    }
  }

  const editUser = (user) => {
    setEditingId(user.id)
    setForm({
      username: user.username,
      password: '',
      name: user.name,
      role: user.role,
      department: user.department,
      status: user.status,
      mustChangePassword: userNeedsPasswordChange(user)
    })
    setMessage('')
    setError('')
  }

  const saveUser = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')
    try {
      if (!formValid) {
        setError(formSaveBlockedReason.replace('保存被阻止：', ''))
        return
      }
      const payload = {
        ...form,
        username: form.username.trim(),
        name: form.name.trim(),
        department: form.department.trim()
      }
      if (!payload.password || payload.role !== '管理员') delete payload.password
      let confirmText = '新增账号'
      if (editingId) {
        const currentUser = users.find(user => user.id === editingId) || {}
        const profileChanged = [
          payload.username !== currentUser.username,
          Boolean(payload.password),
          payload.name !== currentUser.name,
          payload.role !== currentUser.role,
          payload.department !== currentUser.department
        ].some(Boolean)
        const statusChanged = payload.status !== currentUser.status
        const mustChangePasswordChanged = payload.mustChangePassword !== userNeedsPasswordChange(currentUser)
        confirmText = profileChanged
          ? '保存账号资料'
          : statusChanged
            ? '切换账号状态'
            : mustChangePasswordChanged && payload.mustChangePassword
              ? '要求账号改密'
              : ''
      }
      if (confirmText) {
        const typed = window.prompt(`${editingId ? `确认保存账号《${payload.name || payload.username}》的变更？` : `确认新增账号《${payload.name || payload.username}》？`}\n角色：${payload.role}；状态：${payload.status}；部门：${payload.department}\n\n如确认继续，请输入：${confirmText}`)?.trim()
        if (typed !== confirmText) {
          setError(`账号保存已取消：需输入“${confirmText}”才会执行。`)
          return
        }
        payload.confirmText = confirmText
      }
      let completionMessage = ''
      if (editingId) {
        await api.patch(`/users/${editingId}`, payload)
        completionMessage = '账号修改成功'
      } else {
        const created = await api.post('/users', payload)
        completionMessage = '账号新增成功；一次性临时密码仅在当前弹窗显示，请立即安全交付'
        if (created?.temporaryPassword) {
          setCopyFallback({
            open: true,
            title: '一次性临时密码',
            description: '该密码由服务端随机生成且仅返回一次。请通过安全渠道交付，用户首次登录后必须修改。',
            content: `账号：${created.username || payload.username}\n一次性临时密码：${created.temporaryPassword}`
          })
        }
      }
      resetForm()
      setMessage(completionMessage)
      await loadUsers()
    } catch (err) {
      setError(err.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const toggleStatus = async (user) => {
    const nextStatus = user.status === '启用' ? '停用' : '启用'
    const adminWarning = user.role === '管理员' && nextStatus === '停用'
      ? '\n该账号是管理员账号，停用后会影响后台管理入口。'
      : ''
    const confirmText = '切换账号状态'
    const typed = window.prompt(`确认${nextStatus}账号《${user.name}》？${adminWarning}\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`账号状态更新已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingId(user.id)
    setError('')
    setMessage('')
    try {
      await api.patch(`/users/${user.id}`, { status: nextStatus, confirmText })
      setMessage(`账号已${nextStatus === '启用' ? '启用' : '停用'}`)
      await loadUsers()
    } catch (err) {
      setError(err.message || '状态更新失败')
    } finally {
      setActingId('')
    }
  }

  const resetPassword = async (user) => {
    const isAdmin = user.role === '管理员'
    let nextPassword = ''
    if (isAdmin) {
      nextPassword = window.prompt(`请输入《${user.name}》新的管理员密码：\n至少 8 位，需同时包含字母和数字，且不能使用系统默认密码。`) || ''
      if (!nextPassword) return
      if (nextPassword.length < 8 || !/[A-Za-z]/.test(nextPassword) || !/\d/.test(nextPassword)) {
        setError('管理员新密码至少 8 位，且需同时包含字母和数字')
        setMessage('')
        return
      }
    }
    const confirmText = '重置账号密码'
    const confirmDescription = isAdmin
      ? `确认更新管理员《${user.name}》的登录密码？该账号当前会话将失效。`
      : `确认重置《${user.name}》的密码？系统将生成仅显示一次的随机临时密码，该账号下次登录必须修改。`
    const typed = window.prompt(`${confirmDescription}\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`密码重置已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingId(user.id)
    setError('')
    setMessage('')
    try {
      const payload = isAdmin ? { password: nextPassword, confirmText } : { confirmText }
      const data = await api.post(`/users/${user.id}/reset-password`, payload)
      if (!isAdmin && data?.temporaryPassword) {
        setCopyFallback({
          open: true,
          title: '一次性临时密码',
          description: '该密码由服务端随机生成且仅返回一次。请通过安全渠道交付，用户首次登录后必须修改。',
          content: `账号：${user.username}\n一次性临时密码：${data.temporaryPassword}`
        })
      }
      setMessage(isAdmin ? `《${user.name}》管理员密码已更新` : `《${user.name}》密码已重置；一次性临时密码仅在当前弹窗显示`)
      await loadUsers()
    } catch (err) {
      setError(err.message || '密码重置失败')
    } finally {
      setActingId('')
    }
  }

  const requirePasswordChange = async (user) => {
    const confirmText = '要求账号改密'
    const typed = window.prompt(`确认要求《${user.name}》下次登录必须修改密码？\n该账号当前会话将失效。\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`要求改密已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingId(user.id)
    setError('')
    setMessage('')
    try {
      await api.patch(`/users/${user.id}`, { mustChangePassword: true, confirmText })
      setMessage(`已要求《${user.name}》下次登录修改密码`)
      await loadUsers()
    } catch (err) {
      setError(err.message || '密码状态更新失败')
    } finally {
      setActingId('')
    }
  }

  const unlockLogin = async (user) => {
    if (!user.loginLocked) return
    const confirmText = '解除登录锁定'
    const typed = window.prompt(`确认解除账号《${user.name}》的登录锁定？\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`解除锁定已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingId(user.id)
    setError('')
    setMessage('')
    try {
      await api.post(`/users/${user.id}/unlock-login`, { confirmText })
      setMessage(`已解除《${user.name}》的登录锁定`)
      await loadUsers()
    } catch (err) {
      setError(err.message || '解除登录锁定失败')
    } finally {
      setActingId('')
    }
  }

  const addTrustedLoginIp = async (user) => {
    if (!user.lastLoginIp || user.trustedLoginIp) return
    const confirmText = '维护可信IP'
    const typed = window.prompt(`确认将登录 IP《${user.lastLoginIp}》加入可信白名单？加入后，该 IP 不再参与同 IP 多账号风险标记。\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`可信 IP 更新已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingId(user.id)
    setError('')
    setMessage('')
    try {
      const data = await api.post('/users/trusted-login-ip', { ip: user.lastLoginIp, confirmText })
      setMessage(data.changed ? `已将 IP《${user.lastLoginIp}》加入可信白名单` : `IP《${user.lastLoginIp}》已在可信白名单中`)
      await loadUsers()
    } catch (err) {
      setError(err.message || '可信登录 IP 更新失败')
    } finally {
      setActingId('')
    }
  }

  const removeTrustedLoginIp = async (user) => {
    if (!user.lastLoginIp || !user.trustedLoginIp) return
    const confirmText = '维护可信IP'
    const typed = window.prompt(`确认将登录 IP《${user.lastLoginIp}》移出可信白名单？移出后，该 IP 会重新参与同 IP 多账号风险标记。\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`可信 IP 更新已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingId(user.id)
    setError('')
    setMessage('')
    try {
      const data = await api.post('/users/trusted-login-ip', { ip: user.lastLoginIp, action: 'remove', confirmText })
      setMessage(data.changed ? `已将 IP《${user.lastLoginIp}》移出可信白名单` : `IP《${user.lastLoginIp}》不在可信白名单中`)
      await loadUsers()
    } catch (err) {
      setError(err.message || '可信登录 IP 更新失败')
    } finally {
      setActingId('')
    }
  }

  const removeUser = async (user) => {
    const confirmText = '删除账号'
    const typed = window.prompt(`删除账号《${user.name}》后不可恢复。\n\n如确认继续，请输入：${confirmText}`) || ''
    if (typed.trim() !== confirmText) {
      setError(`账号删除已取消：需输入“${confirmText}”才会执行。`)
      return
    }
    setActingId(user.id)
    setError('')
    setMessage('')
    try {
      await api.delete(`/users/${user.id}`, { confirmText })
      if (editingId === user.id) resetForm()
      setMessage('账号已删除')
      await loadUsers()
    } catch (err) {
      setError(err.message || '账号删除失败')
    } finally {
      setActingId('')
    }
  }

  const runBulkAction = async (action) => {
    const selectedCount = selectedUsers.length
    if (!selectedCount) return setError('请先选择需要处理的账号')
    if (action === 'disable' && bulkDisableWouldRemoveAllAdmins) {
      return setError('批量停用会导致没有启用状态的管理员账号，请至少保留 1 个启用管理员')
    }
    if (action === 'requirePasswordChange' && selectedRiskSummary.requirePasswordChangeEligible === 0) {
      return setError('当前选择中没有可要求改密的非管理员账号')
    }

    const actionText = action === 'disable' ? '停用' : action === 'unlockLogin' ? '解除登录锁定' : '要求下次登录改密'
    const confirmLines = [
      `确认对已选 ${selectedCount} 个账号执行“${actionText}”？`,
      '',
      '账号风险',
      `管理员：${selectedRiskSummary.admins} 个`,
      `启用管理员：${selectedRiskSummary.activeAdmins} 个`,
      ...(action === 'requirePasswordChange'
        ? [
            `可要求改密使用者：${selectedRiskSummary.requirePasswordChangeEligible} 个`,
            `将跳过管理员或已需改密账号：${selectedRiskSummary.requirePasswordChangeSkipped} 个`
          ]
        : []),
      `已停用：${selectedRiskSummary.disabled} 个`,
      `默认密码：${selectedRiskSummary.defaultPassword} 个`,
      `从未登录：${selectedRiskSummary.neverLogin} 个`,
      `长期未登录：${selectedRiskSummary.inactiveLogin} 个`,
      `同 IP 多账号：${selectedRiskSummary.sharedLoginIp} 个`,
      `登录锁定：${selectedRiskSummary.loginLocked} 个`,
      '',
      '权限能力',
      `可提交：${selectedRiskSummary.canSubmit} 个`,
      `可审核：${selectedRiskSummary.canReview} 个`,
      `可看日志：${selectedRiskSummary.canViewLogs} 个`,
      `可管人员：${selectedRiskSummary.canManageUsers} 个`,
      `可管系统：${selectedRiskSummary.canManageSystem} 个`
    ]
    const confirmText = '批量处理账号'
    const typed = window.prompt(`${confirmLines.join('\n')}\n\n如确认继续，请输入：${confirmText}`)?.trim()
    if (typed !== confirmText) {
      setError(`批量操作已取消：需输入“${confirmText}”才会执行。`)
      return
    }

    setActingId('bulk')
    setError('')
    setMessage('')
    try {
      const data = await api.post('/users/bulk-action', { ids: selectedIds, action, confirmText })
      const changedCount = data.changedCount ?? data.count ?? selectedCount
      const skippedCount = data.skippedCount ?? Math.max(0, selectedCount - changedCount)
      const skipReasons = [
        data.skippedAdminCount ? `管理员 ${data.skippedAdminCount} 个` : '',
        data.skippedAlreadyRequiredCount ? `已需改密 ${data.skippedAlreadyRequiredCount} 个` : '',
        data.skippedAlreadyDisabledCount ? `已停用 ${data.skippedAlreadyDisabledCount} 个` : '',
        data.skippedUnlockedCount ? `未锁定 ${data.skippedUnlockedCount} 个` : ''
      ].filter(Boolean)
      setSelectedIds([])
      const auditQuery = data.auditId || data.auditKeyword || actionText
      setLastBulkAuditQuery(auditQuery)
      setMessage(`已批量处理 ${data.count || selectedCount} 个账号，实际更新 ${changedCount} 个，跳过 ${skippedCount} 个${skipReasons.length ? `（${skipReasons.join('，')}）` : ''}${data.auditId ? `，批次 ${data.auditId}` : ''}${action === 'requirePasswordChange' ? '，可继续生成改密通知文案（未发送）' : ''}`)
      await loadUsers()
    } catch (err) {
      setError(err.message || '批量操作失败')
    } finally {
      setActingId('')
    }
  }

  const exportUsers = async () => {
    if (exportDisabled) return
    setExporting(true)
    const defaultPasswordLogUrl = `${window.location.origin}${adminDefaultPasswordDeniedLogPath}`
    const exportAuditId = `USER-EXPORT-${Date.now()}`
    setLastExportAuditId(exportAuditId)
    const exportRiskSummary = {
      defaultPasswordCount: exportTargetUsers.filter(user => user.usesDefaultPassword).length,
      mustChangePasswordCount: exportTargetUsers.filter(userNeedsPasswordChange).length,
      loginLockedCount: exportTargetUsers.filter(user => user.loginLocked).length,
      inactiveLoginCount: exportTargetUsers.filter(user => user.loginRisk === '长期未登录').length,
      roleSummary: roleOptions.map(role => ({
        role,
        total: exportTargetUsers.filter(user => user.role === role).length,
        enabled: exportTargetUsers.filter(user => user.role === role && user.status === '启用').length
      })).filter(item => item.total > 0)
    }
    const exportRoleSummaryText = exportRiskSummary.roleSummary.length
      ? exportRiskSummary.roleSummary.map(item => `${item.role} ${item.enabled}/${item.total}`).join('；')
      : '无'
    const exportRolePermissionSnapshotText = roleOptions.length
      ? roleOptions.map(role => {
        const permissions = Array.isArray(rolePermissions[role]) ? rolePermissions[role] : []
        const labels = permissionSetSummary(permissions)
        const codes = permissions.length ? permissions.join('/') : 'none'
        return `${role}：${labels}（${codes}）`
      }).join('；')
      : '无'
    const header = ['姓名', '账号', '角色', '角色边界', '权限范围', '权限代码', '能力标签', '部门', '账号状态', '登录锁定', '失败次数', '锁定到期时间', '密码状态', '是否默认密码', '处理建议', '默认密码拒绝日志', '登录风险', '未登录天数', '最近登录', '最近登录IP', '是否可信IP', '同IP账号', '密码更新时间', '创建时间']
    const filters = {
      status: statusFilter,
      password: passwordFilter,
      role: roleFilter,
      login: loginFilter,
      security: securityFilter,
      permission: permissionFilter,
      keyword: keyword.trim()
    }
    const metaRows = [
      ['文件名称', '账号安全清单'],
      ['导出批次', exportAuditId],
      ['导出时间', new Date().toLocaleString('zh-CN', { hour12: false })],
      ['导出范围', exportScope],
      ['导出数量', exportTargetUsers.length],
      ['默认密码风险数', exportRiskSummary.defaultPasswordCount],
      ['需改密账号数', exportRiskSummary.mustChangePasswordCount],
      ['登录锁定账号数', exportRiskSummary.loginLockedCount],
      ['长期未登录账号数', exportRiskSummary.inactiveLoginCount],
      ['角色分布（启用/总计）', exportRoleSummaryText],
      ['角色权限矩阵快照', exportRolePermissionSnapshotText],
      ['默认密码拒绝日志', defaultPasswordLogUrl],
      ['账号状态筛选', filters.status],
      ['密码状态筛选', filters.password],
      ['角色筛选', filters.role],
      ['登录状态筛选', filters.login],
      ['登录IP筛选', ipFilter],
      ['账号安全筛选', filters.security],
      ['权限范围筛选', permissionFilterText(filters.permission)],
      ['关键词', filters.keyword || '无'],
      []
    ]
    const rows = exportTargetUsers.map(user => [
      user.name,
      user.username,
      user.role,
      roleBoundaryText(user.role, user.permissions),
      permissionSummary(user),
      (Array.isArray(user.permissions) ? user.permissions : []).join('；'),
      permissionCapabilityTags(user.permissions).join('；'),
      user.department,
      user.status,
      user.loginLocked ? '是' : '否',
      user.failedLoginCount || 0,
      displayDateTime(user.loginLockedUntil),
      userPasswordStatusText(user),
      user.usesDefaultPassword ? '是' : '否',
      passwordActionAdvice(user),
      user.usesDefaultPassword ? defaultPasswordLogUrl : '',
      user.loginRisk || '正常',
      user.inactiveDays ?? '',
      user.lastLoginAt || '从未登录',
      user.lastLoginIp || '',
      user.trustedLoginIp ? '是' : '否',
      (user.sameLoginIpAccounts || []).map(item => `${item.name}(${item.username})`).join('；'),
      user.passwordUpdatedAt || '',
      user.createdAt || ''
    ])
    const csv = [...metaRows, header, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `账号安全清单-${new Date().toISOString().slice(0, 10)}-${exportAuditId}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setError('')
    try {
      await api.post('/users/export-audit', {
        count: exportTargetUsers.length,
        filters: {
          ...filters,
          ip: ipFilter,
          scope: exportScope
        },
        riskSummary: {
          ...exportRiskSummary,
          rolePermissionSnapshot: roleOptions.map(role => ({
            role,
            permissions: Array.isArray(rolePermissions[role]) ? rolePermissions[role] : [],
            permissionText: permissionSetSummary(Array.isArray(rolePermissions[role]) ? rolePermissions[role] : [])
          }))
        },
        defaultPasswordLogUrl,
        exportAuditId
      })
      setMessage(`已导出 ${exportScope} ${exportTargetUsers.length} 个账号的安全清单，并写入导出日志，批次 ${exportAuditId}；CSV 已包含权限代码和能力标签。`)
    } catch (err) {
      setMessage(`已导出 ${exportScope} ${exportTargetUsers.length} 个账号的安全清单，批次 ${exportAuditId}；CSV 已包含权限代码和能力标签。`)
      setError(err.message || '导出日志写入失败')
    } finally {
      setExporting(false)
    }
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

  const PasswordBadge = ({ user }) => (
    <div className="space-y-1 min-w-[118px]">
      <span className={`px-2 py-1 rounded text-xs border ${
        user.usesDefaultPassword
          ? 'text-red-300 bg-red-500/10 border-red-400/30'
          : userNeedsPasswordChange(user)
          ? 'text-amber-300 bg-amber-500/10 border-amber-400/30'
          : 'text-emerald-300 bg-emerald-500/10 border-emerald-400/30'
      }`}>
        {userPasswordStatusText(user)}
      </span>
      <div className="text-[11px] text-slate-500 whitespace-nowrap">{user.passwordUpdatedAt || '未记录'}</div>
    </div>
  )

  return (
    <div className="grid grid-cols-12 gap-4">
      <section className="col-span-12 xl:col-span-8 space-y-4">
        <Panel className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h1 className="text-xl font-bold text-blue-200 flex items-center gap-2">
                <UsersRound size={21} />
                人员管理
              </h1>
              <p className="text-sm text-slate-400 mt-1">管理员保留系统和人员管理能力；非管理员账号按当前角色权限矩阵授予提交、审核或日志权限。</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => navigate('/stats?focus=security')}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-400/30 bg-amber-500/10 text-amber-100 text-sm"
              >
                <ShieldAlert size={16} aria-hidden="true" />
                安全统计
              </button>
              <button
                type="button"
                onClick={() => navigate('/logs?type=账号安全&range=近30天')}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-violet-400/30 bg-violet-500/10 text-violet-100 text-sm"
              >
                <ShieldCheck size={16} aria-hidden="true" />
                安全日志
              </button>
              <button
                type="button"
                onClick={exportUsers}
                disabled={exportDisabled}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 text-cyan-100 disabled:opacity-50 text-sm"
              >
                <Download size={16} aria-hidden="true" />
                {exporting ? '导出中...' : exportButtonLabel}
              </button>
              <button type="button" onClick={() => startCreateUser()} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-blue-400/40 bg-blue-600/20 text-blue-100 text-sm">
                <Plus size={16} aria-hidden="true" />
                新增账号
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-4 gap-3 mb-4">
            <MetricFilterButton
              label="启用账号"
              value={enabledCount}
              hint="点击筛选启用账号"
              tone="emerald"
              title={`筛选启用账号，当前 ${enabledCount} 个`}
              onClick={() => setStatusFilter('启用')}
            />
            <MetricFilterButton
              label="停用账号"
              value={disabledCount}
              hint="点击筛选停用账号"
              tone="slate"
              title={`筛选停用账号，当前 ${disabledCount} 个`}
              onClick={() => setStatusFilter('停用')}
            />
            {roleSummaries.map(item => (
              <MetricFilterButton
                key={item.role}
                label={`启用${item.role}`}
                value={item.enabled}
                hint={`点击筛选${item.role}，总计 ${item.total}`}
                tone={item.role === '管理员' ? 'cyan' : item.role === '使用者' ? 'blue' : 'slate'}
                title={`筛选启用${item.role}账号，当前启用 ${item.enabled} 个，总计 ${item.total} 个`}
                onClick={() => setRoleFilter(item.role, '启用')}
              />
            ))}
            <MetricFilterButton
              label="需改密账号"
              value={mustChangePasswordCount}
              hint="点击筛选待改密"
              tone="amber"
              title={`筛选需改密账号，当前 ${mustChangePasswordCount} 个`}
              onClick={() => setPasswordFilter('需改密')}
            />
            <MetricFilterButton
              label="默认密码风险"
              value={defaultPasswordCount}
              hint="点击筛选风险账号"
              tone="red"
              title={`筛选默认密码风险账号，当前 ${defaultPasswordCount} 个，使用者 ${defaultPasswordUserCount} 个，管理员 ${defaultPasswordAdminCount} 个`}
              onClick={() => setPasswordFilter('默认密码')}
            />
            <MetricFilterButton
              label="从未登录账号"
              value={neverLoginCount}
              hint="点击筛选未登录"
              tone="violet"
              title={`筛选从未登录账号，当前 ${neverLoginCount} 个`}
              onClick={() => setLoginFilter('从未登录')}
            />
            <MetricFilterButton
              label={`${inactiveLoginThresholdDays} 天未登录`}
              value={inactiveLoginCount}
              hint="点击筛选沉睡账号"
              tone="rose"
              title={`筛选超过 ${inactiveLoginThresholdDays} 天未登录账号，当前 ${inactiveLoginCount} 个`}
              onClick={() => setLoginFilter('长期未登录')}
            />
            <MetricFilterButton
              label={`同 IP 达 ${sharedLoginIpAccountThreshold} 个账号`}
              value={sharedLoginIpCount}
              hint="点击筛选共用来源"
              tone="sky"
              title={`筛选同 IP 多账号风险，阈值 ${sharedLoginIpAccountThreshold} 个账号，当前 ${sharedLoginIpCount} 个`}
              onClick={() => setIpFilter('同IP多账号')}
            />
            <MetricFilterButton
              label="可信登录 IP"
              value={trustedLoginIpAccountCount}
              hint={`点击筛选命中账号，白名单来源 ${trustedLoginIpCount} 个`}
              tone="emerald"
              title={`筛选可信登录 IP 命中账号，当前 ${trustedLoginIpAccountCount} 个，白名单来源 ${trustedLoginIpCount} 个`}
              onClick={() => setIpFilter('可信IP')}
            />
            <MetricFilterButton
              label="登录锁定账号"
              value={loginLockedCount}
              hint="点击筛选待解锁账号"
              tone="orange"
              title={`筛选登录锁定账号，当前 ${loginLockedCount} 个`}
              onClick={() => setSecurityFilter('登录锁定')}
            />
            <MetricFilterButton
              label="系统配置权限"
              value={manageSystemCount}
              hint="点击筛选可管系统账号"
              tone="cyan"
              title={`筛选具备系统配置权限的账号，当前 ${manageSystemCount} 个`}
              onClick={() => setPermissionFilter('manageSystem')}
            />
            <MetricFilterButton
              label="人员管理权限"
              value={manageUsersCount}
              hint="点击筛选可管人员账号"
              tone="blue"
              title={`筛选具备人员管理权限的账号，当前 ${manageUsersCount} 个`}
              onClick={() => setPermissionFilter('manageUsers')}
            />
            <MetricFilterButton
              label="方案提交权限"
              value={submitProposalCount}
              hint="点击筛选可提交账号"
              tone="emerald"
              title={`筛选具备方案提交权限的账号，当前 ${submitProposalCount} 个`}
              onClick={() => setPermissionFilter('submitProposal')}
            />
            <MetricFilterButton
              label="审核流转权限"
              value={reviewProposalCount}
              hint="点击筛选可审核账号"
              tone="cyan"
              title={`筛选具备审核流转权限的账号，当前 ${reviewProposalCount} 个`}
              onClick={() => setPermissionFilter('reviewProposal')}
            />
            <MetricFilterButton
              label="日志查看权限"
              value={viewLogsCount}
              hint="点击筛选可看日志账号"
              tone="violet"
              title={`筛选具备日志查看权限的账号，当前 ${viewLogsCount} 个`}
              onClick={() => setPermissionFilter('viewLogs')}
            />
            <MetricFilterButton
              label="仅提交权限"
              value={submitOnlyCount}
              hint="点击筛选只提交账号"
              tone="slate"
              title={`筛选仅具备提交权限的账号，当前 ${submitOnlyCount} 个`}
              onClick={() => setPermissionFilter('submitOnly')}
            />
          </div>

          <div className="mb-4 flex items-center gap-2 rounded-lg border border-blue-500/25 bg-slate-900/80 px-3 py-2 text-slate-400">
            <Search size={16} />
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder-slate-500"
              placeholder="搜索姓名、账号、角色、部门或登录 IP"
            />
          </div>
          <div className="mb-4 text-xs text-slate-500">
            当前命中 {filteredUsers.length} 个账号 / 总计 {users.length} 个账号
          </div>

          {defaultPasswordCount > 0 && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <span className="inline-flex items-center gap-2">
                <ShieldAlert size={16} aria-hidden="true" />
                当前有 {defaultPasswordCount} 个账号仍在使用系统默认密码，其中使用者 {defaultPasswordUserCount} 个、管理员 {defaultPasswordAdminCount} 个，应尽快完成改密。
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setPasswordFilter('默认密码')} className="text-xs text-red-100 hover:text-white">
                  查看账号
                </button>
                <button type="button" onClick={() => selectRiskUsers('defaultPasswordUsers')} className="text-xs text-red-100 hover:text-white">
                  选择使用者
                </button>
                <button type="button" onClick={() => navigate('/stats?focus=security')} className="text-xs text-red-100 hover:text-white">
                  安全统计
                </button>
                <button type="button" onClick={() => navigate(adminDefaultPasswordDeniedLogPath)} className="text-xs text-red-100 hover:text-white">
                  查看拒绝日志
                </button>
              </div>
            </div>
          )}

          {mustChangePasswordCount > 0 && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              <span>
                当前有 {mustChangePasswordCount} 个账号需要下次登录修改密码。
                {userConfig.latestPasswordNotice
                  ? ` 最近文案生成：${userConfig.latestPasswordNotice.auditId || '未记录'}，涉及 ${userConfig.latestPasswordNotice.affectedAccountCount ?? userConfig.latestPasswordNotice.noticeCount ?? 0} 个账号，状态未发送，${userConfig.latestPasswordNotice.at || '时间未记录'}。`
                  : ' 尚未发现最近改密通知文案生成留痕。'}
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={copyPasswordChangeNotice} className="inline-flex items-center gap-1 text-xs text-amber-100 hover:text-white">
                  <Copy size={13} aria-hidden="true" />
                  复制改密通知文案
                </button>
                {userConfig.latestPasswordNotice?.auditId && (
                  <button type="button" onClick={() => navigate(`/logs?type=账号安全&q=${encodeURIComponent(userConfig.latestPasswordNotice.auditId)}`)} className="text-xs text-amber-100 hover:text-white">
                    查看最近文案留痕
                  </button>
                )}
                {latestNoticeUsernames.length > 0 && (
                  <button type="button" onClick={() => setSearchParams(prev => {
                    const next = new URLSearchParams(prev)
                    next.set('notice', 'latest')
                    next.set('select', 'visible')
                    next.delete('q')
                    return next
                  })} className="text-xs text-amber-100 hover:text-white">
                    查看文案涉及账号
                  </button>
                )}
                <button type="button" onClick={() => setPasswordFilter('需改密')} className="text-xs text-amber-100 hover:text-white">
                  查看账号
                </button>
                <button type="button" onClick={() => navigate('/stats?focus=security')} className="text-xs text-amber-100 hover:text-white">
                  安全统计
                </button>
              </div>
            </div>
          )}

          {inactiveLoginCount > 0 && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              <span>当前有 {inactiveLoginCount} 个账号超过 {inactiveLoginThresholdDays} 天未登录，可结合业务情况批量停用。</span>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setLoginFilter('长期未登录')} className="text-xs text-rose-100 hover:text-white">
                  查看账号
                </button>
                <button type="button" onClick={() => navigate('/stats?focus=security')} className="text-xs text-rose-100 hover:text-white">
                  安全统计
                </button>
              </div>
            </div>
          )}

          {sharedLoginIpCount > 0 && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-400/25 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
              <span>当前有 {sharedLoginIpCount} 个账号来自同 IP 达 {sharedLoginIpAccountThreshold} 个账号的非白名单来源，建议核查是否存在共用账号或代登录。</span>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setIpFilter('同IP多账号')} className="text-xs text-sky-100 hover:text-white">
                  查看账号
                </button>
                <button type="button" onClick={() => navigate('/stats?focus=security')} className="text-xs text-sky-100 hover:text-white">
                  安全统计
                </button>
              </div>
            </div>
          )}

          {(statusFilter !== '全部' || passwordFilter !== '全部' || roleFilter !== '全部' || loginFilter !== '全部' || ipFilter !== '全部' || securityFilter !== '全部' || permissionFilter !== '全部' || noticeFilter || keyword.trim()) && (
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3">
              <div className="min-w-0 text-sm text-slate-300">
                <div className="text-xs text-slate-500">当前筛选</div>
                <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                  {activeFilterTags.map(item => (
                    <span key={`${item.label}-${item.value}`} className={`rounded-md border px-2 py-0.5 ${riskBadgeClass(item.tone)}`}>
                      {item.label}：{item.value}
                    </span>
                  ))}
                </div>
              </div>
              <button type="button" onClick={clearFilters} className="text-xs text-blue-300 hover:text-blue-200">清除筛选</button>
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-3">
            <div className="text-sm text-slate-300">
              已选择 {selectedUsers.length} 个账号
              {selectedVisibleCount > 0 ? `，当前列表中 ${selectedVisibleCount} 个` : ''}
              {selectedUsers.length > 0 && (
                <div className="mt-2 flex flex-col gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-slate-500">选择范围</span>
                    {selectedScopeBadges.map(item => (
                      <span key={item.label} className={`rounded-md border px-2 py-0.5 ${riskBadgeClass(item.tone)}`}>
                        {item.label} {item.value}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-slate-500">风险摘要</span>
                    {selectedRiskBadges.map(item => (
                      <span key={item.label} className={`rounded-md border px-2 py-0.5 ${riskBadgeClass(item.tone)}`}>
                        {item.label} {item.value}
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-slate-500">权限能力</span>
                    {selectedCapabilitySummary.map(item => (
                      <span key={item.label} className={`rounded-md border px-2 py-0.5 ${capabilityTagClass(item.label)}`}>
                        {item.label} {item.value}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {selectedPasswordChangeNoticeOnly && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                  <span>已选账号已经处于需改密状态，下一步是通知使用者登录完成改密。</span>
                  <button type="button" onClick={copyPasswordChangeNotice} className="inline-flex items-center gap-1 rounded border border-amber-300/30 bg-slate-950/25 px-2 py-1 text-amber-100 hover:border-amber-200/60">
                    <Copy size={13} aria-hidden="true" />
                    复制已选通知
                  </button>
                </div>
              )}
              {bulkDisableWouldRemoveAllAdmins && (
                <div className="mt-1 text-xs text-red-300">当前选择会停用全部启用管理员，系统已阻止批量停用。</div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={toggleSelectVisible}
                disabled={visibleIds.length === 0}
                className="rounded-lg border border-blue-400/25 bg-blue-500/10 px-3 py-2 text-xs text-blue-100 disabled:opacity-50"
                title={`${visibleSelectionActionText}：${activeFilterSummaryText}`}
              >
                {visibleSelectionActionText}
              </button>
              <button
                type="button"
                onClick={() => selectRiskUsers('defaultPassword')}
                disabled={defaultPasswordCount === 0}
                className="rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-100 disabled:opacity-50"
              >
                选择默认密码
              </button>
              <button
                type="button"
                onClick={() => selectRiskUsers('defaultPasswordUsers')}
                disabled={defaultPasswordUserCount === 0}
                className="rounded-lg border border-orange-400/25 bg-orange-500/10 px-3 py-2 text-xs text-orange-100 disabled:opacity-50"
                title="只选择使用者默认密码账号，便于批量要求改密；管理员需单独设置非默认强密码"
              >
                选择默认密码使用者
              </button>
              <button
                type="button"
                onClick={() => navigate(adminDefaultPasswordDeniedLogPath)}
                className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100"
              >
                默认密码拒绝日志
              </button>
              <button
                type="button"
                onClick={() => selectRiskUsers('neverLogin')}
                disabled={neverLoginCount === 0}
                className="rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-2 text-xs text-violet-100 disabled:opacity-50"
              >
                选择从未登录
              </button>
              <button
                type="button"
                onClick={() => selectRiskUsers('inactiveLogin')}
                disabled={inactiveLoginCount === 0}
                className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-100 disabled:opacity-50"
              >
                选择长期未登录
              </button>
              <button
                type="button"
                onClick={() => selectRiskUsers('sharedLoginIp')}
                disabled={sharedLoginIpCount === 0}
                className="rounded-lg border border-sky-400/25 bg-sky-500/10 px-3 py-2 text-xs text-sky-100 disabled:opacity-50"
              >
                选择同 IP 多账号
              </button>
              <button
                type="button"
                onClick={() => selectRiskUsers('loginLocked')}
                disabled={loginLockedCount === 0}
                className="rounded-lg border border-orange-400/25 bg-orange-500/10 px-3 py-2 text-xs text-orange-100 disabled:opacity-50"
              >
                选择登录锁定
              </button>
              <button
                type="button"
                onClick={() => runBulkAction('requirePasswordChange')}
                disabled={actingId === 'bulk' || selectedRiskSummary.requirePasswordChangeEligible === 0}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100 disabled:opacity-50"
                title={selectedRiskSummary.requirePasswordChangeEligible === 0 ? '当前选择中没有可要求改密的非管理员账号' : '仅对未处于需改密状态的非管理员账号生效'}
              >
                <KeyRound size={14} aria-hidden="true" />
                批量要求改密
              </button>
              <button
                type="button"
                onClick={() => runBulkAction('disable')}
                disabled={actingId === 'bulk' || selectedUsers.length === 0 || bulkDisableWouldRemoveAllAdmins}
                className="inline-flex items-center gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-100 disabled:opacity-50"
              >
                <Power size={14} aria-hidden="true" />
                批量停用
              </button>
              <button
                type="button"
                onClick={() => runBulkAction('unlockLogin')}
                disabled={actingId === 'bulk' || selectedRiskSummary.loginLocked === 0}
                className="inline-flex items-center gap-2 rounded-lg border border-orange-400/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-100 disabled:opacity-50"
              >
                <ShieldCheck size={14} aria-hidden="true" />
                批量解锁
              </button>
              {selectedUsers.length > 0 && (
                <button type="button" onClick={clearSelectedUsers} className="rounded-lg border border-blue-400/25 px-3 py-2 text-xs text-blue-200">
                  清空选择
                </button>
              )}
            </div>
            {bulkActionHints.length > 0 && (
              <div className="basis-full rounded-lg border border-slate-700/70 bg-slate-950/45 px-3 py-2 text-xs">
                <div className="mb-1 text-slate-500">批量操作提示</div>
                <div className="flex flex-wrap gap-1.5">
                  {bulkActionHints.map(item => (
                    <div key={item.label} className={`inline-flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 ${riskBadgeClass(item.tone)}`}>
                      <span>{item.label}：{item.text}</span>
                      <button
                        type="button"
                        onClick={() => runBulkHintAction(item.actionKey)}
                        className="rounded border border-current/25 bg-slate-950/25 px-2 py-0.5 text-[11px] hover:bg-slate-950/45"
                      >
                        {item.actionLabel}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {loading ? (
            <div role="status" aria-live="polite" className="text-center py-12 text-slate-400">加载中...</div>
          ) : filteredUsers.length === 0 ? (
            <div role="status" aria-live="polite" className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-4 py-12 text-center">
              <div className="text-sm text-slate-300">没有匹配的账号</div>
              <div className="mt-2 text-xs text-slate-500">可调整关键词、角色、状态或密码状态筛选条件。</div>
              {activeFilterTags.length > 0 && (
                <div className="mx-auto mt-4 flex max-w-2xl flex-wrap justify-center gap-1.5 text-xs">
                  {activeFilterTags.map(item => (
                    <span key={`${item.label}-${item.value}`} className={`rounded-md border px-2 py-0.5 ${riskBadgeClass(item.tone)}`}>
                      {item.label}：{item.value}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button type="button" onClick={clearFilters} className="rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-100">
                  清除筛选
                </button>
                <button type="button" onClick={() => startCreateUser({ resetFilters: true })} className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                  新增账号
                </button>
                <button type="button" onClick={() => setPasswordFilter('默认密码')} disabled={defaultPasswordCount === 0} className="rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-100 disabled:opacity-50">
                  查看默认密码
                </button>
                <button type="button" onClick={() => setSecurityFilter('登录锁定')} disabled={loginLockedCount === 0} className="rounded-lg border border-orange-400/25 bg-orange-500/10 px-3 py-2 text-xs text-orange-100 disabled:opacity-50">
                  查看登录锁定
                </button>
                <button type="button" onClick={() => setIpFilter('同IP多账号')} disabled={sharedLoginIpCount === 0} className="rounded-lg border border-sky-400/25 bg-sky-500/10 px-3 py-2 text-xs text-sky-100 disabled:opacity-50">
                  查看同 IP 多账号
                </button>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                aria-label={`人员账号列表，当前命中 ${filteredUsers.length} 个账号，筛选条件：${activeFilterSummaryText}`}
              >
                <caption className="sr-only">
                  人员账号列表。当前命中 {filteredUsers.length} 个账号，筛选条件：{activeFilterSummaryText}。第一列复选框用于选择账号并执行批量操作。
                </caption>
                <thead className="text-slate-400 bg-slate-900/70">
                  <tr>
                    <th className="text-left py-2 px-3 font-medium whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectVisible}
                        className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                        title={`${visibleSelectionActionText} ${visibleIds.length} 个账号：${activeFilterSummaryText}`}
                        aria-label={`${visibleSelectionActionText} ${visibleIds.length} 个当前列表账号，筛选条件：${activeFilterSummaryText}`}
                      />
                    </th>
                    {userTableColumns.map(item => (
                      <th key={item.label} title={item.title} aria-label={`${item.label}：${item.title}`} className="text-left py-2 px-3 font-medium whitespace-nowrap">{item.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map(user => (
                    <tr key={user.id} className="border-b border-blue-500/10 hover:bg-blue-500/5">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(user.id)}
                          onChange={() => toggleSelectUser(user)}
                          disabled={!canManageAccount(currentUser, user)}
                          className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                          title={!canManageAccount(currentUser, user) ? '不能选择超出当前权限范围的账号' : undefined}
                          aria-label={!canManageAccount(currentUser, user) ? `账号《${user.name || user.username}》超出当前权限管理范围` : `${selectedIds.includes(user.id) ? '取消选择' : '选择'}账号《${user.name || user.username}》，账号 ${user.username || '未填写'}，角色 ${user.role || '未设置'}，状态 ${user.status || '未知'}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-medium text-blue-100">{user.name}</td>
                      <td className="px-3 py-2 text-slate-300">{user.username}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-200">{user.role}</div>
                        <div className="mt-1 max-w-[190px] text-xs leading-relaxed text-slate-500">
                          {user.role === '管理员' ? '系统与人员管理账号' : '按权限矩阵授权账号'}
                        </div>
                        <div className="mt-1 flex max-w-[180px] flex-wrap gap-1">
                          {permissionCapabilityTags(user.permissions).map(tag => (
                            <span key={tag} className={`rounded-md border px-2 py-0.5 text-xs ${capabilityTagClass(tag)}`}>
                              {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex max-w-[220px] flex-wrap gap-1">
                          {(Array.isArray(user.permissions) ? user.permissions : []).map(permission => (
                            <span key={permission} className="rounded-md border border-blue-400/20 bg-blue-500/10 px-2 py-0.5 text-xs text-blue-100">
                              {permissionLabels[permission] || permission}
                            </span>
                          ))}
                          {(!Array.isArray(user.permissions) || user.permissions.length === 0) && <span className="text-xs text-slate-500">无权限</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-300">{user.department}</td>
                      <td className="px-3 py-2">
                        <StatusBadge status={user.status} />
                  {user.loginLocked && (
                    <div className="mt-2 text-xs text-orange-300">
                      登录已锁定，失败 {user.failedLoginCount || 0} 次
                      {user.loginLockedUntil && <div className="mt-1 text-orange-200">至 {displayDateTime(user.loginLockedUntil)}</div>}
                    </div>
                  )}
                      </td>
                      <td className="px-3 py-2"><PasswordBadge user={user} /></td>
                      <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                        {user.lastLoginAt ? (
                          <div>
                            <div>{user.lastLoginAt}</div>
                            {user.lastLoginIp && <div className="mt-1 text-xs text-slate-500">IP：{user.lastLoginIp}</div>}
                            {user.trustedLoginIp && <div className="mt-1 text-xs text-emerald-300">可信登录 IP</div>}
                            {user.lastLoginIp && user.trustedLoginIp && (
                              <button
                                type="button"
                                onClick={() => removeTrustedLoginIp(user)}
                                disabled={actingId === user.id}
                                className="mt-1 text-xs text-amber-300 hover:text-amber-200 disabled:opacity-50"
                              >
                                移出可信白名单
                              </button>
                            )}
                            {user.lastLoginIp && !user.trustedLoginIp && (
                              <button
                                type="button"
                                onClick={() => addTrustedLoginIp(user)}
                                disabled={actingId === user.id}
                                className="mt-1 text-xs text-emerald-300 hover:text-emerald-200 disabled:opacity-50"
                              >
                                加入可信白名单
                              </button>
                            )}
                            {!user.trustedLoginIp && user.sameLoginIpAccountCount >= sharedLoginIpAccountThreshold && <div className="mt-1 text-xs text-sky-300">同 IP {user.sameLoginIpAccountCount} 个账号</div>}
                            {!user.trustedLoginIp && user.sameLoginIpAccountCount >= sharedLoginIpAccountThreshold && (
                              <div className="mt-1 max-w-[260px] whitespace-normal text-xs text-slate-500">
                                {(user.sameLoginIpAccounts || []).map(item => `${item.name}(${item.username})`).join('、')}
                              </div>
                            )}
                            {user.loginRisk === '长期未登录' && <div className="mt-1 text-xs text-rose-300">已 {user.inactiveDays} 天未登录</div>}
                          </div>
                        ) : (
                          <span className="text-violet-300">从未登录</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{user.createdAt}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <button type="button" onClick={() => editUser(user)} disabled={!canManageAccount(currentUser, user)} title={!canManageAccount(currentUser, user) ? '不能修改超出当前权限范围的账号' : `编辑账号《${user.name || user.username}》`} aria-label={!canManageAccount(currentUser, user) ? `账号《${user.name || user.username}》超出当前权限管理范围` : `编辑账号《${user.name || user.username}》`} className="inline-flex items-center gap-1 text-blue-300 hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-40">
                            <Edit3 size={15} aria-hidden="true" />
                            修改
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleStatus(user)}
                            disabled={actingId === user.id || !canManageAccount(currentUser, user)}
                            title={!canManageAccount(currentUser, user) ? '不能切换超出当前权限范围账号的状态' : `需要输入“${user.status === '启用' ? '停用账号' : '启用账号'}”后才会${user.status === '启用' ? '停用' : '启用'}该账号`}
                            aria-label={!canManageAccount(currentUser, user) ? `账号《${user.name || user.username}》超出当前权限管理范围` : `${user.status === '启用' ? '停用' : '启用'}账号《${user.name || user.username}》：需要输入确认文本后才会执行`}
                            className="inline-flex items-center gap-1 text-amber-300 hover:text-amber-200 disabled:opacity-50"
                          >
                            <Power size={15} aria-hidden="true" />
                            {user.status === '启用' ? '停用' : '启用'}
                          </button>
                          <button
                            type="button"
                            onClick={() => resetPassword(user)}
                            disabled={actingId === user.id || !canManageAccount(currentUser, user)}
                            title={!canManageAccount(currentUser, user) ? '不能重置超出当前权限范围账号的密码' : user.role === '管理员' ? '需要输入新管理员密码后才会更新' : '需要输入“重置密码”后才会重置为默认密码'}
                            aria-label={!canManageAccount(currentUser, user) ? `账号《${user.name || user.username}》超出当前权限管理范围` : `${user.role === '管理员' ? '设置管理员密码' : '重置密码'}《${user.name || user.username}》：${user.role === '管理员' ? '需要输入新管理员密码后才会更新' : '需要输入确认文本后才会重置为默认密码'}`}
                            className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-200 disabled:opacity-50"
                          >
                            <KeyRound size={15} aria-hidden="true" />
                            {user.role === '管理员' ? '设置密码' : '重置密码'}
                          </button>
                          {user.loginLocked && (
                            <button
                              type="button"
                              onClick={() => unlockLogin(user)}
                              disabled={actingId === user.id || !canManageAccount(currentUser, user)}
                              title={!canManageAccount(currentUser, user) ? '不能解除超出当前权限范围账号的登录锁定' : '需要输入“解除锁定”后才会解除登录锁定'}
                              aria-label={!canManageAccount(currentUser, user) ? `账号《${user.name || user.username}》超出当前权限管理范围` : `解除账号《${user.name || user.username}》的登录锁定：需要输入确认文本后才会执行`}
                              className="inline-flex items-center gap-1 text-orange-300 hover:text-orange-200 disabled:opacity-50"
                            >
                              <ShieldCheck size={15} aria-hidden="true" />
                              解除锁定
                            </button>
                          )}
                          {user.role !== '管理员' && !userNeedsPasswordChange(user) && (
                            <button
                              type="button"
                              onClick={() => requirePasswordChange(user)}
                              disabled={actingId === user.id || !canManageAccount(currentUser, user)}
                              title={!canManageAccount(currentUser, user) ? '不能要求超出当前权限范围的账号改密' : '需要输入“要求改密”后才会要求该账号下次登录修改密码'}
                              aria-label={!canManageAccount(currentUser, user) ? `账号《${user.name || user.username}》超出当前权限管理范围` : `要求账号《${user.name || user.username}》下次登录修改密码：需要输入确认文本后才会执行`}
                              className="inline-flex items-center gap-1 text-violet-300 hover:text-violet-200 disabled:opacity-50"
                            >
                              <KeyRound size={15} aria-hidden="true" />
                              要求改密
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => removeUser(user)}
                            disabled={actingId === user.id || !canManageAccount(currentUser, user)}
                            title={!canManageAccount(currentUser, user) ? '不能删除超出当前权限范围的账号' : '需要输入“删除账号”后才会执行'}
                            aria-label={!canManageAccount(currentUser, user) ? `账号《${user.name || user.username}》超出当前权限管理范围` : `删除账号《${user.name || user.username}》：需要输入确认文本后才会执行`}
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

      <aside className="col-span-12 xl:col-span-4">
        <Panel className="p-5">
          <h2 className="font-semibold text-blue-100 mb-4">{editingId ? '修改账号' : '新增账号'}</h2>
          <form onSubmit={saveUser} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-3">
              <label className="block" htmlFor={nameInputId}>
                <span className="text-sm text-slate-300">姓名</span>
                <input id={nameInputId} value={form.name} onChange={e => updateForm('name', e.target.value)} required minLength={2} aria-invalid={normalizedName.length < 2} aria-describedby={normalizedName.length < 2 ? formErrorId : undefined} autoComplete="name" className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60" placeholder="请输入姓名" />
              </label>
              <label className="block" htmlFor={usernameInputId}>
                <span className="text-sm text-slate-300">账号</span>
                <input id={usernameInputId} value={form.username} onChange={e => updateForm('username', e.target.value)} required minLength={2} aria-invalid={normalizedUsername.length < 2} aria-describedby={normalizedUsername.length < 2 ? formErrorId : undefined} autoComplete="username" className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60" placeholder="请输入账号" />
              </label>
              <label className="block" htmlFor={passwordInputId}>
                <span className="text-sm text-slate-300">密码</span>
                <input
                  id={passwordInputId}
                  type="password"
                  value={form.password}
                  onChange={e => updateForm('password', e.target.value)}
                  aria-describedby={formSaveBlockedReason ? `${passwordRulesId} ${formErrorId}` : passwordRulesId}
                  aria-invalid={Boolean(formSaveBlockedReason)}
                  autoComplete="new-password"
                  disabled={form.role !== '管理员'}
                  required={!editingId && form.role === '管理员'}
                  minLength={form.role === '管理员' && (passwordTouched || !editingId) ? 8 : undefined}
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder={form.role !== '管理员' ? '普通账号由系统生成一次性临时密码' : editingId ? '留空则不修改密码' : '请输入管理员强密码'}
                />
                {form.role !== '管理员' && (
                  <div id={passwordRulesId} className="mt-2 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                    普通账号由服务端随机生成一次性临时密码，仅在创建或重置成功后显示一次。
                  </div>
                )}
                {form.role === '管理员' && (passwordTouched || !editingId) && (
                  <div id={passwordRulesId} aria-live="polite" className="mt-2 grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-1 gap-2">
                    {passwordChecks.map(item => {
                      const Icon = item.passed ? CheckCircle2 : XCircle
                      return (
                        <div
                          key={item.key}
                          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                            item.passed
                              ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200'
                              : 'border-slate-500/20 bg-slate-900/60 text-slate-400'
                          }`}
                        >
                          <Icon size={14} aria-hidden="true" />
                          {item.label}
                        </div>
                      )
                    })}
                  </div>
                )}
              </label>
              <label className="block" htmlFor={roleSelectId}>
                <span className="text-sm text-slate-300">角色</span>
                <select id={roleSelectId} value={form.role} onChange={e => updateForm('role', e.target.value)} disabled={!isAdministrator && editingSelf} title={!isAdministrator && editingSelf ? '普通人员管理员不能修改自己的角色' : '选择账号角色'} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60 disabled:cursor-not-allowed disabled:opacity-50">
                  {editableRoleOptions.map(role => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
                <div className="mt-1 text-xs text-slate-500">
                  当前角色权限：{permissionSetSummary(formRolePermissions)}
                </div>
                <div className={`mt-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                  form.role === '管理员'
                    ? 'border-amber-400/25 bg-amber-500/10 text-amber-100'
                    : 'border-blue-400/20 bg-blue-500/10 text-blue-100'
                }`}>
                  {formRoleBoundaryText}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {formRoleCapabilityTags.map(tag => (
                    <span key={tag} className={`rounded-md border px-2 py-0.5 text-xs ${capabilityTagClass(tag)}`}>
                      {tag}
                    </span>
                  ))}
                </div>
              </label>
              <label className="block" htmlFor={departmentInputId}>
                <span className="text-sm text-slate-300">部门</span>
                <input id={departmentInputId} value={form.department} onChange={e => updateForm('department', e.target.value)} required aria-invalid={!normalizedDepartment} aria-describedby={!normalizedDepartment ? formErrorId : undefined} autoComplete="organization" className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60" placeholder="请输入部门" />
              </label>
              <label className="block" htmlFor={statusSelectId}>
                <span className="text-sm text-slate-300">状态</span>
                <select id={statusSelectId} value={form.status} onChange={e => updateForm('status', e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60">
                  <option value="启用">启用</option>
                  <option value="停用">停用</option>
                </select>
              </label>
              {form.role !== '管理员' && (
                <label className="flex items-start gap-3 rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-2" htmlFor={mustChangePasswordId}>
                  <input
                    id={mustChangePasswordId}
                    type="checkbox"
                    checked={form.mustChangePassword}
                    onChange={e => updateForm('mustChangePassword', e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-slate-500 bg-slate-900 text-blue-500"
                  />
                  <span>
                    <span className="block text-sm text-slate-300">下次登录必须修改密码</span>
                    <span className="block text-xs text-slate-500 mt-1">适用于初始账号、重置密码或安全风险处理。</span>
                  </span>
                </label>
              )}
            </div>

            <div className="rounded-lg border border-blue-500/20 bg-slate-900/60 px-3 py-3">
              <div className="text-xs text-slate-500">保存影响</div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                {formSaveImpactBadges.map(item => (
                  <span key={item.label} className={`rounded-md border px-2 py-0.5 ${riskBadgeClass(item.tone)}`}>
                    {item.label}：{item.value}
                  </span>
                ))}
              </div>
            </div>

            {error && <div role="alert" className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
            {message && (
              <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-3 text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                <span>{message}</span>
                {userMessageActions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {userMessageActions.map(action => {
                      const ActionIcon = messageActionIcon(action)
                      const actionHint = action.hint || action.label
                      return (
                        <button
                          key={action.to || action.actionKey}
                          type="button"
                          onClick={() => runMessageAction(action)}
                          title={actionHint}
                          aria-label={`${action.label}：${actionHint}`}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${messageActionClass(action)}`}
                        >
                          <ActionIcon size={13} aria-hidden="true" />
                          {action.label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {formSaveBlockedReason && (
              <div id={formErrorId} role="alert" className="rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                {formSaveBlockedReason}
              </div>
            )}

            <div className="flex gap-2">
              <button type="submit" disabled={saving || !formValid} title={formSaveBlockedReason || '保存账号'} aria-label={formSaveBlockedReason || (saving ? '正在保存账号' : '保存账号')} className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm border border-blue-300/40">
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
      <CopyFallbackDialog
        open={copyFallback.open}
        title={copyFallback.title}
        description={copyFallback.description}
        content={copyFallback.content}
        onClose={() => setCopyFallback({ open: false, title: '', description: '', content: '' })}
      />
    </div>
  )
}
