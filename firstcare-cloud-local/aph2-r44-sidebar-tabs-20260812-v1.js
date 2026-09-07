(() => {
  'use strict'

  const RELEASE = 'r44-sidebar-tabs-20260812-v1'
  const OPEN_TABS_KEY = 'aph-open-tabs-v1'
  const navigation = performance.getEntriesByType('navigation')[0]
  const isReload = navigation?.type === 'reload'

  document.documentElement.dataset.r44Release = RELEASE
  document.documentElement.dataset.r44Navigation = navigation?.type || 'unknown'

  if (isReload) {
    window.sessionStorage.removeItem(OPEN_TABS_KEY)
    document.documentElement.dataset.r44TabsReset = 'true'
  }
})()
