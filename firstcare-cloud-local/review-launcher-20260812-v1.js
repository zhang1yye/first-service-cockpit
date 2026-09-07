/* R55：以驾驶舱 Bearer 身份换取审核系统一次性票据。 */
(() => {
  'use strict'

  const status = document.getElementById('review-launcher-status')
  const actions = document.getElementById('review-launcher-actions')
  const retry = document.getElementById('review-launcher-retry')
  let connecting = false

  function setFailure(message) {
    status.textContent = message
    status.setAttribute('role', 'alert')
    actions.hidden = false
    document.body.dataset.reviewLauncherState = 'failed'
    retry.focus()
  }

  function cockpitToken() {
    return localStorage.getItem('cockpit_token')
      || localStorage.getItem('authToken')
      || ''
  }

  function reviewToken() {
    return localStorage.getItem('token')
      || localStorage.getItem('review_token')
      || ''
  }

  async function hasReviewSession(token) {
    if (!token) return false
    const response = await fetch('/review-api/auth/session', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    }).catch(() => null)
    return Boolean(response?.ok)
  }

  async function connect() {
    if (connecting) return
    connecting = true
    actions.hidden = true
    status.setAttribute('role', 'status')
    status.textContent = '正在校验驾驶舱身份并建立安全会话…'
    document.body.dataset.reviewLauncherState = 'connecting'

    const token = cockpitToken()
    if (!token) {
      if (await hasReviewSession(reviewToken())) {
        window.location.replace('/review-system/')
        return
      }
      connecting = false
      setFailure('当前浏览器没有可用登录会话，请重新登录驾驶舱。')
      return
    }

    try {
      const response = await fetch('/api/integrations/review/sso', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.url) {
        if (await hasReviewSession(reviewToken())) {
          window.location.replace('/review-system/')
          return
        }
        throw new Error(payload.error || payload.message || `身份校验失败（${response.status}）`)
      }

      const target = new URL(payload.url, window.location.origin)
      if (target.origin !== window.location.origin || !target.pathname.startsWith('/review-system/')) {
        throw new Error('审核系统返回了不受信任的跳转地址')
      }
      status.textContent = '身份校验通过，正在打开审核工作台…'
      window.location.replace(`${target.pathname}${target.search}${target.hash}`)
    } catch (error) {
      connecting = false
      setFailure(error?.message || '研发审核系统暂时无法连接，请稍后重试。')
    }
  }

  retry.addEventListener('click', connect)
  connect()
})()
