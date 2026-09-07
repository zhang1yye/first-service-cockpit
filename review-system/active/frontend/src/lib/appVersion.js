import packageJson from '../../package.json'

export const appVersion = import.meta.env.VITE_APP_VERSION || `v${packageJson.version || '0.0.1'}`
export const appBuildTime = import.meta.env.VITE_BUILD_TIME || ''

export function formatBuildTime(value = appBuildTime) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).replaceAll('/', '-')
}

export const appBuildTimeText = formatBuildTime()
export const appBuildLabel = appBuildTimeText ? `${appVersion} · ${appBuildTimeText}` : appVersion

export default appVersion
