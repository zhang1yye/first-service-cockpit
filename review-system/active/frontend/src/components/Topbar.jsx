import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, KeyRound, Menu, MessageCircle, Search, UserRound, LogOut, RefreshCw, X } from '../lib/lucide.js'
import { api, logout, getUser, getSessionRemainingMs, logoutLocal, rememberLoginRedirect, safeRedirectPath, refreshSession } from '../lib/api'
import firstServiceLogo from '../assets/brand/first-service-logo-2026-transparent.png'
import { appBuildLabel, appVersion } from '../lib/appVersion'
import { hasPermission } from '../lib/permissions'
import { preloadRoute } from '../lib/routePreload'
import { notificationRefreshEvent } from '../lib/notifications'

export default function Topbar({ onMenuClick }) {
  const navigate = useNavigate()
  const [nowTick, setNowTick] = useState(Date.now())
  const [refreshingSession, setRefreshingSession] = useState(false)
  const [sessionMessage, setSessionMessage] = useState('')
  const [sessionMessageTone, setSessionMessageTone] = useState('status')
  const [searchText, setSearchText] = useState('')
  const [searchMessage, setSearchMessage] = useState('')
  const [needReminderCount, setNeedReminderCount] = useState(null)
  const [notificationState, setNotificationState] = useState('loading')
  const user = getUser()
  const canReview = hasPermission(user, 'reviewProposal')
  const canViewLogs = hasPermission(user, 'viewLogs')
  const canManageSystem = hasPermission(user, 'manageSystem')
  const canManageUsers = hasPermission(user, 'manageUsers')
  const canSubmit = hasPermission(user, 'submitProposal')
  const canViewSecurityOps = (canManageUsers || canManageSystem) && canViewLogs
  const canChangePassword = user?.role !== '管理员'
  const sessionExpiresAt = localStorage.getItem('sessionExpiresAt')
  const sessionExpiresText = sessionExpiresAt
    ? new Date(sessionExpiresAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : ''
  const sessionRemainingMs = getSessionRemainingMs()
  const sessionRemainingMinutes = sessionRemainingMs === null ? null : Math.max(0, Math.ceil(sessionRemainingMs / 60000))
  const sessionExpiringSoon = sessionRemainingMinutes !== null && sessionRemainingMinutes <= 10
  const searchPlaceholder = canViewSecurityOps ? '搜索方案、日志、账号安全或默认密码' : canReview ? '搜索方案、提交人或审核状态' : canViewLogs ? '搜索审计日志' : '当前账号暂无搜索入口'
  const searchLabel = canViewSecurityOps
    ? '全局搜索，支持方案、日志、账号安全或默认密码'
    : canReview
      ? '搜索方案、提交人或审核状态'
      : canViewLogs
        ? '搜索审计日志'
        : '当前账号暂无搜索入口'
  const canUseSearch = canReview || canViewLogs
  const searchSubmitLabel = searchText.trim()
    ? `提交搜索：${searchText.trim()}`
    : canUseSearch
      ? '请输入关键词后提交搜索'
      : '当前账号暂无搜索入口'
  const clearSearchLabel = searchText.trim() ? `清空搜索关键词：${searchText.trim()}` : '清空搜索关键词'
  const reminderQueueLabel = notificationState === 'error'
    ? '打开待催办审核队列，提醒状态暂不可用'
    : notificationState === 'loading'
      ? '打开待催办审核队列，正在读取提醒状态'
      : needReminderCount > 0
        ? `打开待催办审核队列，建议催办 ${needReminderCount} 个`
        : '打开待催办审核队列，当前暂无建议催办'
  const sessionRefreshLabel = refreshingSession
    ? '正在续期当前登录会话'
    : sessionRemainingMinutes !== null
      ? `续期当前登录会话，剩余 ${sessionRemainingMinutes} 分钟`
      : '续期当前登录会话'
  const changePasswordLabel = `修改当前账号 ${user?.username || user?.name || ''} 的密码`
  const logoutLabel = `退出当前账号 ${user?.username || user?.name || user?.role || ''}`

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!canReview) {
      setNeedReminderCount(0)
      setNotificationState('ready')
      return
    }
    let active = true
    const refreshNotifications = () => {
      api.get('/notifications/summary')
        .then(data => {
          if (active) {
            setNeedReminderCount(Number(data.needReminderCount) || 0)
            setNotificationState('ready')
          }
        })
        .catch(() => {
          if (active) {
            setNeedReminderCount(null)
            setNotificationState('error')
          }
        })
    }
    const refreshOnFocus = () => {
      if (document.visibilityState === 'visible') refreshNotifications()
    }
    refreshNotifications()
    const timer = window.setInterval(refreshNotifications, 60000)
    window.addEventListener('focus', refreshNotifications)
    window.addEventListener(notificationRefreshEvent, refreshNotifications)
    document.addEventListener('visibilitychange', refreshOnFocus)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshNotifications)
      window.removeEventListener(notificationRefreshEvent, refreshNotifications)
      document.removeEventListener('visibilitychange', refreshOnFocus)
    }
  }, [canReview])

  useEffect(() => {
    if (sessionRemainingMs !== null && sessionRemainingMs <= 0) {
      const redirectTarget = safeRedirectPath(`${window.location.pathname}${window.location.search}${window.location.hash}`)
      rememberLoginRedirect(redirectTarget)
      logoutLocal()
      navigate(`/login?reason=session-expired&redirect=${encodeURIComponent(redirectTarget)}`, { replace: true })
    }
  }, [navigate, nowTick, sessionRemainingMs])

  const doLogout = async () => {
    await logout()
    navigate('/login?reason=logged-out', { replace: true })
  }

  const doRefreshSession = async () => {
    setRefreshingSession(true)
    setSessionMessage('')
    setSessionMessageTone('status')
    try {
      await refreshSession()
      setNowTick(Date.now())
      setSessionMessageTone('status')
      setSessionMessage('会话已续期')
      window.setTimeout(() => setSessionMessage(''), 2400)
    } catch (err) {
      setSessionMessageTone('alert')
      setSessionMessage(err.message || '会话续期失败')
      window.setTimeout(() => setSessionMessage(''), 3000)
    } finally {
      setRefreshingSession(false)
    }
  }

  const completeSearch = (path, label) => {
    navigate(path)
    setSearchText('')
    setSearchMessage(`已跳转到${label}`)
    window.setTimeout(() => setSearchMessage(''), 2400)
  }

  const clearSearch = () => {
    setSearchText('')
    setSearchMessage('已清空搜索关键词')
    window.setTimeout(() => setSearchMessage(''), 1800)
  }

  const clearSearchOnEscape = (event) => {
    if (event.key === 'Escape' && searchText) {
      event.preventDefault()
      clearSearch()
    }
  }

  const submitSearch = (event) => {
    event.preventDefault()
    const keyword = searchText.trim()
    if (!keyword) return
    const normalizedKeyword = keyword.toLowerCase()
    if (canViewLogs && ['登录失败', '失败登录', '登录锁定日志', '账号锁定日志', '安全拦截', '拦截日志', '权限拒绝', '管理员改密拒绝', '管理员强制改密拒绝', '强制改密拒绝', '管理员默认密码拒绝'].some(item => keyword.includes(item))) {
      const query = new URLSearchParams({ type: '账号安全' })
      if (keyword.includes('失败')) query.set('result', '失败')
      if (keyword.includes('锁定')) query.set('result', '锁定')
      if (keyword.includes('拦截')) query.set('result', '拦截')
      if (keyword.includes('拒绝')) query.set('result', '拒绝')
      if (keyword.includes('管理员改密拒绝')) query.set('q', '管理员账号修改密码被拒绝')
      if (keyword.includes('强制改密拒绝')) query.set('q', '下次登录改密被拒绝')
      if (keyword.includes('管理员默认密码拒绝')) query.set('q', '默认密码')
      completeSearch(`/logs?${query.toString()}`, '账号安全日志')
      return
    }
    if (canManageUsers && ['默认密码', '初始密码'].some(item => keyword.includes(item))) {
      completeSearch('/users?password=默认密码&select=visible', '默认密码账号列表')
      return
    }
    if (canManageUsers && ['最近通知', '通知账号', '改密通知', '密码通知'].some(item => keyword.includes(item))) {
      completeSearch('/users?notice=latest&select=visible', '最近生成通知文案涉及账号列表')
      return
    }
    if (canManageUsers && ['需改密', '修改密码', '改密'].some(item => keyword.includes(item))) {
      completeSearch('/users?password=需改密&select=visible', '需改密账号列表')
      return
    }
    if (canManageUsers && ['登录锁定', '账号锁定'].some(item => keyword.includes(item))) {
      completeSearch('/users?security=登录锁定&select=visible', '登录锁定账号列表')
      return
    }
    if (canViewSecurityOps && ['账号安全', '安全分析', '安全统计'].some(item => keyword.includes(item))) {
      completeSearch('/stats?focus=security', '账号安全分析')
      return
    }
    if (canViewLogs && ['login', 'password', 'security'].some(item => normalizedKeyword.includes(item))) {
      completeSearch(`/logs?type=${encodeURIComponent('账号安全')}&q=${encodeURIComponent(keyword)}`, '账号安全日志')
      return
    }
    if (canReview) {
      completeSearch(`/review?q=${encodeURIComponent(keyword)}&sort=${encodeURIComponent('最新提交优先')}`, '审核中心搜索结果')
      return
    }
    if (canViewLogs) {
      completeSearch(`/logs?q=${encodeURIComponent(keyword)}`, '审计日志搜索结果')
    }
  }

  const openReminderQueue = () => {
    if (canReview) navigate('/review?needReminder=1')
  }

  const openHelpEntry = () => {
    if (canManageSystem) {
      navigate('/settings')
      return
    }
    if (canReview) {
      navigate('/review?needReminder=1')
      return
    }
    if (canSubmit) {
      navigate('/submit')
      return
    }
    if (canViewLogs) {
      navigate('/logs')
    }
  }

  const helpTitle = canManageSystem
    ? '打开系统设置与上线检查'
    : canReview
      ? '打开待催办审核队列'
      : canSubmit
        ? '打开方案提交'
        : canViewLogs
          ? '打开日志中心'
          : '当前账号暂无帮助入口'

  return (
    <header className="aph-topbar h-14 px-3 sm:px-5 flex items-center justify-between gap-2">
      <div className="aph-topbar-brand">
        <img src={firstServiceLogo} alt="第一服务" />
        <strong>APH 2.0</strong>
        <span>研发小组审核系统</span>
      </div>
      <button type="button" className="aph-menu-button h-10 w-10 shrink-0 grid place-items-center" onClick={onMenuClick} title="打开侧边菜单" aria-label="打开侧边菜单">
        <Menu size={20} aria-hidden="true" />
      </button>
      <div className="mr-2 hidden h-10 w-28 shrink-0 items-center justify-center p-1.5 sm:w-32">
        <img src={firstServiceLogo} alt="第一服务" className="h-full w-full object-contain drop-shadow-[0_0_8px_rgba(255,255,255,.25)]" />
      </div>
      <form
        onSubmit={submitSearch}
        onFocus={() => preloadRoute(canReview ? '/review' : '/logs')}
        className="hidden md:flex items-center gap-2 w-[420px] px-4 py-2 rounded-xl border border-[#365670]/70 bg-[#091423]/90 text-[#9aadb8] focus-within:border-[#00ccf9]/60"
      >
        <Search size={18} aria-hidden="true" />
        <input
          value={searchText}
          onChange={event => setSearchText(event.target.value)}
          onKeyDown={clearSearchOnEscape}
          disabled={!canUseSearch}
          aria-label={searchLabel}
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 outline-none disabled:cursor-not-allowed"
          placeholder={searchPlaceholder}
        />
        <button
          type="button"
          onClick={clearSearch}
          disabled={!canUseSearch || !searchText}
          title={clearSearchLabel}
          aria-label={clearSearchLabel}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-500 transition hover:bg-slate-500/15 hover:text-slate-200 disabled:pointer-events-none disabled:opacity-0"
        >
          <X size={15} aria-hidden="true" />
        </button>
        <button
          type="submit"
          disabled={!canUseSearch || !searchText.trim()}
          title={searchSubmitLabel}
          aria-label={searchSubmitLabel}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-blue-500/15 hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Search size={15} aria-hidden="true" />
        </button>
      </form>
      {searchMessage && (
        <span role="status" aria-live="polite" className="sr-only">
          {searchMessage}
        </span>
      )}
      <div className="flex items-center gap-2 sm:gap-3 xl:gap-5 ml-auto min-w-0">
        {canReview && (
          <button
            type="button"
            onClick={openReminderQueue}
            className="relative hidden lg:grid h-10 w-10 place-items-center rounded-xl text-[#9aadb8] transition hover:bg-amber-500/10 hover:text-amber-200"
            title={reminderQueueLabel}
            aria-label={reminderQueueLabel}
          >
            <Bell size={19} aria-hidden="true" />
            {notificationState === 'error' && (
              <>
                <span aria-hidden="true" className="absolute right-0 top-0 min-w-5 rounded-full bg-amber-500 px-1.5 text-center text-[11px] font-bold leading-5 text-slate-950">
                  !
                </span>
                <span role="status" aria-live="polite" className="sr-only">提醒状态暂不可用</span>
              </>
            )}
            {notificationState === 'ready' && needReminderCount > 0 && (
              <>
                <span aria-hidden="true" className="absolute right-0 top-0 min-w-5 rounded-full bg-red-500 px-1.5 text-center text-[11px] leading-5 text-white">
                  {needReminderCount > 99 ? '99+' : needReminderCount}
                </span>
                <span className="sr-only">当前有 {needReminderCount} 个建议催办</span>
              </>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={openHelpEntry}
          disabled={!canManageSystem && !canReview && !canSubmit && !canViewLogs}
          className="hidden lg:inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-[#dfe6eb] transition hover:bg-[#00ccf9]/10 hover:text-[#00ccf9] disabled:cursor-not-allowed disabled:opacity-50"
          title={helpTitle}
          aria-label={helpTitle}
        >
          <MessageCircle size={18} aria-hidden="true" />
          <span className="hidden xl:inline">快捷帮助</span>
        </button>
        <a
          href="/"
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-blue-300/40 bg-blue-600/20 px-4 text-sm font-semibold text-blue-100 transition hover:border-blue-200/70 hover:bg-blue-600/35 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          title="返回华北智能驾驶舱"
          aria-label="返回华北智能驾驶舱"
        >
          返回驾驶舱
        </a>
      </div>
    </header>
  )
}
