/* R74：刷新期间保护当前已打开页签；DOMContentLoaded 后恢复原生存储行为。 */
(() => {
  'use strict'

  const RELEASE = 'r74-refresh-tabs-preserve-20260813-v1'
  const OPEN_TABS_KEY = 'aph-open-tabs-v1'
  const navigation = performance.getEntriesByType('navigation')[0]
  const snapshot = window.sessionStorage.getItem(OPEN_TABS_KEY)

  document.documentElement.dataset.r74TabsPreserve = RELEASE
  if (navigation?.type !== 'reload' || !snapshot) return

  const nativeRemoveItem = Storage.prototype.removeItem
  const guardedRemoveItem = function guardedRemoveItem(key) {
    if (this === window.sessionStorage && key === OPEN_TABS_KEY) {
      document.documentElement.dataset.r74TabsResetBlocked = 'true'
      return undefined
    }
    return nativeRemoveItem.call(this, key)
  }

  Storage.prototype.removeItem = guardedRemoveItem

  window.addEventListener('DOMContentLoaded', () => {
    if (Storage.prototype.removeItem === guardedRemoveItem) {
      Storage.prototype.removeItem = nativeRemoveItem
    }
    if (window.sessionStorage.getItem(OPEN_TABS_KEY) !== snapshot) {
      window.sessionStorage.setItem(OPEN_TABS_KEY, snapshot)
    }
    document.documentElement.dataset.r74TabsPreserved = 'true'
  }, { once: true })
})()
