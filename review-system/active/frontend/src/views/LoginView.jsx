import { useId, useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { UserRound, KeyRound, Eye, EyeOff } from '../lib/lucide.js'
import { login, isLoggedIn, getLoginRedirect, rememberLoginRedirect, safeRedirectPath, getUser, clearLoginRedirect } from '../lib/api'
import { redirectPathForUser, shouldForcePasswordChange } from '../lib/permissions'
import Panel from '../components/Panel'
import firstServiceLogo from '../assets/brand/first-service-logo-2026-transparent.png'

const routeLabelMap = {
  '/': '工作台',
  '/submit': '提交方案',
  '/review': '审核中心',
  '/bots': '机器人配置',
  '/users': '账号管理',
  '/knowledge': '知识库',
  '/rules': '规则配置',
  '/stats': '数据分析',
  '/logs': '审计日志',
  '/settings': '系统设置'
}

const loginReasonMap = {
  'session-expired': {
    tone: 'amber',
    text: '登录会话已失效，请重新登录。'
  },
  'logged-out': {
    tone: 'emerald',
    text: '已安全退出登录。'
  },
  'password-required': {
    tone: 'amber',
    text: '当前账号需要先修改密码，请重新登录后完成改密。'
  },
  'permission-denied': {
    tone: 'red',
    text: '当前账号无权访问目标页面，请使用具备权限的账号登录。'
  },
  'redirect-cleared': {
    tone: 'blue',
    text: '已改为登录后进入工作台。'
  }
}

const focusLabelMap = {
  security: '账号安全分析',
  ai: 'AI 调用质量',
  attachments: '附件解析质量',
  export: '意见书导出分析',
  users: '账号结构',
  rules: '规则结构',
  workflow: '审核编排',
  execution: '执行漏斗',
  reminder: '催办分析',
  score: '方案评分分布',
  status: '审核状态分布',
  type: '方案类型统计'
}

function reasonToneClass(tone = 'blue') {
  const tones = {
    blue: 'border-blue-400/25 bg-blue-500/10 text-blue-100',
    amber: 'border-amber-400/30 bg-amber-500/10 text-amber-100',
    emerald: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100',
    red: 'border-red-400/30 bg-red-500/10 text-red-100'
  }
  return tones[tone] || tones.blue
}

function formatRedirectLabel(target = '/') {
  try {
    const url = new URL(target, window.location.origin)
    const baseLabel = routeLabelMap[url.pathname] || (url.pathname.startsWith('/review/') ? '方案详情' : url.pathname.replace(/^\//, '') || '工作台')
    const parameterLabels = [
      ['focus', '聚焦'],
      ['status', '状态'],
      ['type', '类型'],
      ['actionGroup', '动作'],
      ['result', '结果'],
      ['range', '时间'],
      ['exportSource', '导出来源'],
      ['submitter', '提交人'],
      ['proposalType', '方案类型'],
      ['role', '角色'],
      ['password', '密码状态'],
      ['login', '登录状态'],
      ['security', '安全状态'],
      ['risk', '风险'],
      ['attachment', '附件'],
      ['queue', '队列'],
      ['sort', '排序'],
      ['q', '关键词']
    ]
    const details = [
      url.searchParams.get('needReminder') === '1' ? '建议催办' : '',
      ...parameterLabels.map(([key, label]) => {
        const value = url.searchParams.get(key)
        if (key === 'focus' && value) return focusLabelMap[value] || `${label} ${value}`
        return value ? `${label} ${value}` : ''
      })
    ].filter(Boolean)
    const visibleDetails = details.slice(0, 4)
    const hiddenCount = Math.max(0, details.length - visibleDetails.length)
    return [baseLabel, ...visibleDetails, hiddenCount ? `另有 ${hiddenCount} 项筛选` : ''].filter(Boolean).join(' · ')
  } catch {
    return String(target || '/').replace(/^\//, '') || '工作台'
  }
}

export default function LoginView() {
  const navigate = useNavigate()
  const location = useLocation()
  const loginErrorId = useId()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const fromLocation = location.state?.from
    ? `${location.state.from.pathname || '/'}${location.state.from.search || ''}${location.state.from.hash || ''}`
    : ''
  const redirectTarget = safeRedirectPath(
    fromLocation ||
    new URLSearchParams(location.search).get('redirect') ||
    getLoginRedirect()
  )
  const loginReason = new URLSearchParams(location.search).get('reason')
  const reasonMeta = loginReasonMap[loginReason] || null
  const redirectLabel = redirectTarget === '/'
    ? ''
    : formatRedirectLabel(redirectTarget)
  const loginActionLabel = loading
    ? '正在登录第一服务研发小组审核系统'
    : redirectLabel
      ? `登录第一服务研发小组审核系统，成功后返回：${redirectLabel}`
      : '登录第一服务研发小组审核系统'
  const resetRedirectLabel = `清除登录后返回路径，改为进入工作台，当前返回路径：${redirectLabel || '工作台'}`
  const passwordToggleLabel = showPwd ? '隐藏登录密码' : '显示登录密码'

  if (window.location.pathname.startsWith('/review-system')) {
    return (
      <div className="aph-login-shell min-h-screen flex items-center justify-center p-4">
        <div className="aph-login-topbar">
          <span>1</span><strong>第一服务</strong><em>APH 2.0 · 研发小组审核系统</em>
        </div>
        <Panel className="aph-login-panel relative w-full max-w-[460px] p-8 text-center">
          <h1 className="text-xl font-bold tracking-wide">第一服务研发小组审核系统</h1>
          <p className="mt-4 text-sm leading-6 text-slate-300">
            本系统已并入华北智能驾驶舱，不再提供独立登录界面。请先以驾驶舱管理员身份登录，再从左侧菜单“研发小组审核系统”进入。
          </p>
          <a href="/" className="aph-login-action mt-6 inline-flex px-4 py-2 text-sm transition">
            返回华北智能驾驶舱
          </a>
        </Panel>
      </div>
    )
  }

  useEffect(() => {
    if (isLoggedIn()) navigate(redirectPathForUser(getUser(), redirectTarget), { replace: true })
  }, [navigate, redirectTarget])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!username.trim() || !password.trim()) return setError('请输入用户名和密码')
    setError('')
    setLoading(true)
    try {
      const res = await login(username.trim(), password)
      if (shouldForcePasswordChange(res.user)) {
        rememberLoginRedirect(redirectTarget)
        navigate('/change-password', { replace: true, state: { from: redirectTarget } })
        return
      }
      const nextPath = redirectPathForUser(res.user, redirectTarget)
      navigate(nextPath, { replace: true })
    } catch (err) {
      setError(err.message || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const resetRedirect = () => {
    clearLoginRedirect()
    navigate('/login?reason=redirect-cleared', { replace: true })
  }

  return (
    <div className="aph-login-shell min-h-screen flex items-center justify-center p-4 overflow-hidden">
      <div className="aph-login-topbar">
        <span>1</span><strong>第一服务</strong><em>APH 2.0 · 研发小组审核系统</em>
      </div>
      <div className="fixed inset-0 bg-[linear-gradient(rgba(148,163,184,.05)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.05)_1px,transparent_1px)] bg-[size:32px_32px]" />
      <div className="fixed inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-300/35 to-transparent" />
      <div className="fixed inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-slate-500/25 to-transparent" />

      <Panel className="relative w-full max-w-[420px] p-8 animate-fadein">
        <div className="text-center mb-8">
          <div className="mx-auto mb-4 w-56 p-1">
            <img src={firstServiceLogo} alt="第一服务" className="h-16 w-full object-contain drop-shadow-[0_0_10px_rgba(255,255,255,.25)]" />
          </div>
          <h1 className="text-xl font-bold tracking-wide whitespace-nowrap">第一服务研发小组审核系统</h1>
          <p className="text-sm text-slate-400 mt-1">多专业 AI 协同审核</p>
        </div>

        {(reasonMeta || redirectLabel) && (
          <div className={`mb-5 rounded-lg border px-4 py-3 text-sm leading-6 ${reasonToneClass(reasonMeta?.tone)}`}>
            {reasonMeta && <div>{reasonMeta.text}</div>}
            {redirectLabel && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-slate-300">
                <span title={`完整返回路径：${redirectTarget}`}>登录后返回：{redirectLabel}</span>
                <button type="button" onClick={resetRedirect} title={resetRedirectLabel} aria-label={resetRedirectLabel} className="text-xs text-blue-200 hover:text-white">
                  改为进入工作台
                </button>
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-username" className="text-sm text-slate-300 mb-1.5 block">用户名</label>
            <div className="relative">
              <UserRound size={18} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                id="login-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                aria-label="登录用户名"
                aria-describedby={error ? loginErrorId : undefined}
                aria-invalid={Boolean(error)}
                required
                className="w-full pl-10 pr-4 py-3 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-400/60 focus:ring-1 focus:ring-blue-400/30 transition"
                placeholder="请输入用户名"
                autoComplete="username"
              />
            </div>
          </div>

          <div>
            <label htmlFor="login-password" className="text-sm text-slate-300 mb-1.5 block">密码</label>
            <div className="relative">
              <KeyRound size={18} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                id="login-password"
                type={showPwd ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label="登录密码"
                aria-describedby={error ? loginErrorId : undefined}
                aria-invalid={Boolean(error)}
                required
                className="w-full pl-10 pr-12 py-3 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-400/60 focus:ring-1 focus:ring-blue-400/30 transition"
                placeholder="请输入密码"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPwd(!showPwd)}
                title={passwordToggleLabel}
                aria-label={passwordToggleLabel}
                aria-pressed={showPwd}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition"
              >
                {showPwd ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </button>
            </div>
          </div>

          {error && (
            <div id={loginErrorId} role="alert" aria-live="assertive" className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2">{error}</div>
          )}

          <button
            type="submit"
            disabled={loading}
            title={loginActionLabel}
            aria-label={loginActionLabel}
            className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition flex items-center justify-center gap-2 border border-blue-400/40 shadow-cyan"
          >
            {loading ? (
              <>
                <span aria-hidden="true" className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                登录中...
              </>
            ) : '登录'}
          </button>
        </form>

        <p className="text-xs text-slate-500 text-center mt-6">
          首次使用请联系管理员获取账号
        </p>
      </Panel>
    </div>
  )
}
