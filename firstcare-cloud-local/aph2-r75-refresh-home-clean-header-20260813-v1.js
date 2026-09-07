/* R75：刷新时清空工作页签并回到首页，不改变普通点击与前进后退。 */
(() => {
  'use strict'

  const RELEASE = 'r75-refresh-home-clean-header-20260813-v1'
  const OPEN_TABS_KEY = 'aph-open-tabs-v1'
  const navigation = performance.getEntriesByType('navigation')[0]

  document.documentElement.dataset.r75RefreshHome = RELEASE
  const style = document.createElement('style')
  style.dataset.r75CleanHeader = RELEASE
  style.textContent = '.aph-r45-project-gate{display:none!important}'
  document.head.append(style)

  if (navigation?.type !== 'reload') return

  window.sessionStorage.removeItem(OPEN_TABS_KEY)
  document.documentElement.dataset.r75TabsReset = 'true'

  if (window.location.pathname !== '/' && window.location.pathname !== '/login') {
    window.location.replace('/')
  }
})()
