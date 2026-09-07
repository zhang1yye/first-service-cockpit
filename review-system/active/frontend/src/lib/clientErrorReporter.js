import { appBuildLabel, appBuildTime, appVersion } from './appVersion'

const reportedErrors = new Set()
const maxReportedErrors = 8
const reportingTimeoutMs = 3000
let reporting = false

function isReporterError(message = '', source = '') {
  return String(source || '').includes('/api/client-errors') || String(message || '').includes('/api/client-errors')
}

function errorPayload(type, message, details = {}) {
  return {
    type,
    message: String(message || '未知前端异常').slice(0, 300),
    source: String(details.source || '').slice(0, 180),
    stack: String(details.stack || '').slice(0, 1200),
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`.slice(0, 180),
    appVersion,
    appBuildTime,
    appBuildLabel
  }
}

async function postClientError(payload, { silent = true } = {}) {
  const token = localStorage.getItem('token')
  if (reporting || !token || reportedErrors.size >= maxReportedErrors) return false
  if (isReporterError(payload.message, payload.source)) return false

  const key = [payload.type, payload.message, payload.route].join('|')
  if (reportedErrors.has(key)) return false
  reportedErrors.add(key)

  const body = JSON.stringify(payload)
  reporting = true
  const releaseTimer = window.setTimeout(() => {
    reporting = false
  }, reportingTimeoutMs)

  const releaseReportingLock = () => {
    window.clearTimeout(releaseTimer)
    reporting = false
  }

  try {
    const res = await fetch('/api/client-errors', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body,
      keepalive: true
    })
    return res.ok
  } catch (error) {
    if (!silent) throw error
    return false
  } finally {
    releaseReportingLock()
  }
}

export function reportClientErrorForTest() {
  return postClientError(errorPayload('manual-test', `手动测试前端异常上报 ${Date.now()}`, {
    source: '日志中心测试按钮',
    stack: 'manual test from LogsView'
  }), { silent: false })
}

export function reportClientError(type, message, details = {}, options = {}) {
  return postClientError(errorPayload(type, message, details), options)
}

export function installClientErrorReporter() {
  window.addEventListener('error', event => {
    postClientError(errorPayload('runtime', event.message, {
      source: `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`,
      stack: event.error?.stack || ''
    }))
  })

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason
    postClientError(errorPayload('promise', reason?.message || reason, {
      stack: reason?.stack || ''
    }))
  })
}
