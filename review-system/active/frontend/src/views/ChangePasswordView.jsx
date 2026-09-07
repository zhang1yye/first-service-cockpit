import { useId, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { CheckCircle2, KeyRound, Save, XCircle } from '../lib/lucide.js'
import { changePassword, consumeLoginRedirect, getUser, safeRedirectPath } from '../lib/api'
import { redirectPathForUser } from '../lib/permissions'
import Panel from '../components/Panel'

export default function ChangePasswordView() {
  const navigate = useNavigate()
  const location = useLocation()
  const user = getUser()
  const passwordErrorId = useId()
  const passwordMessageId = useId()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  if (user?.role === '管理员') return <Navigate to="/?notice=admin-password-self-service-disabled" replace />

  const passwordChecks = [
    { key: 'length', label: '至少 8 位', passed: newPassword.length >= 8 },
    { key: 'letter', label: '包含字母', passed: /[A-Za-z]/.test(newPassword) },
    { key: 'number', label: '包含数字', passed: /\d/.test(newPassword) },
    { key: 'confirm', label: '两次输入一致', passed: Boolean(confirmPassword) && newPassword === confirmPassword }
  ]
  const passwordReady = oldPassword && passwordChecks.every(item => item.passed)
  const passwordCheckSummary = passwordChecks.map(item => `${item.label}${item.passed ? '已满足' : '未满足'}`).join('，')
  const savePasswordLabel = saving
    ? '正在保存新密码'
    : passwordReady
      ? '保存新密码，当前密码规则已全部满足'
      : `保存新密码暂不可用，${passwordCheckSummary}`

  const savePassword = async (e) => {
    e.preventDefault()
    setError('')
    setMessage('')

    if (!oldPassword || !newPassword || !confirmPassword) return setError('请完整填写原密码、新密码和确认密码')
    if (!passwordChecks.slice(0, 3).every(item => item.passed)) return setError('新密码至少 8 位，且需同时包含字母和数字')

    if (newPassword !== confirmPassword) return setError('两次输入的新密码不一致')

    setSaving(true)
    try {
      await changePassword(oldPassword, newPassword)
      setMessage('密码修改成功')
      const redirectTarget = redirectPathForUser(getUser(), safeRedirectPath(location.state?.from || consumeLoginRedirect()))
      window.setTimeout(() => navigate(redirectTarget, { replace: true }), 500)
    } catch (err) {
      setError(err.message || '密码修改失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-blue-200 flex items-center gap-2">
          <KeyRound size={21} aria-hidden="true" />
          修改密码
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          {user?.mustChangePassword ? '当前账号需要先修改初始或重置密码，完成后再进入系统。' : '定期更新密码可以降低账号风险。'}
        </p>
      </div>

      <Panel className="p-5">
        <form onSubmit={savePassword} className="space-y-4">
          <label className="block" htmlFor="change-password-old">
            <span className="text-sm text-slate-300">原密码</span>
            <input
              id="change-password-old"
              type="password"
              value={oldPassword}
              onChange={e => setOldPassword(e.target.value)}
              aria-label="原密码"
              aria-describedby={error ? passwordErrorId : undefined}
              aria-invalid={Boolean(error)}
              required
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
              autoComplete="current-password"
            />
          </label>
          <label className="block" htmlFor="change-password-new">
            <span className="text-sm text-slate-300">新密码</span>
            <input
              id="change-password-new"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              aria-label="新密码"
              aria-describedby={error ? `password-check-summary ${passwordErrorId}` : 'password-check-summary'}
              aria-invalid={Boolean(error) || (Boolean(newPassword) && !passwordChecks.slice(0, 4).every(item => item.passed))}
              required
              minLength={8}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
              placeholder="至少 8 位，需同时包含字母和数字"
              autoComplete="new-password"
            />
            <div id="password-check-summary" aria-live="polite" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {passwordChecks.map(item => {
                const Icon = item.passed ? CheckCircle2 : XCircle
                return (
                  <div
                    key={item.key}
                    aria-label={`${item.label}：${item.passed ? '已满足' : '未满足'}`}
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
          </label>
          <label className="block" htmlFor="change-password-confirm">
            <span className="text-sm text-slate-300">确认新密码</span>
            <input
              id="change-password-confirm"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              aria-label="确认新密码"
              aria-describedby={error ? passwordErrorId : undefined}
              aria-invalid={Boolean(confirmPassword) && newPassword !== confirmPassword}
              required
              minLength={8}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-blue-500/25 bg-slate-900/80 text-white text-sm outline-none focus:border-blue-400/60"
              autoComplete="new-password"
            />
          </label>

          {error && <div id={passwordErrorId} role="alert" aria-live="assertive" className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>}
          {message && <div id={passwordMessageId} role="status" aria-live="polite" className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">{message}</div>}

          <button
            type="submit"
            disabled={saving || !passwordReady}
            title={savePasswordLabel}
            aria-label={savePasswordLabel}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm border border-blue-300/40"
          >
            <Save size={16} aria-hidden="true" />
            {saving ? '保存中...' : '保存新密码'}
          </button>
        </form>
      </Panel>
    </div>
  )
}
