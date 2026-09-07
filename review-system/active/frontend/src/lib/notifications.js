export const notificationRefreshEvent = 'notifications:refresh'

export function requestNotificationRefresh() {
  window.dispatchEvent(new CustomEvent(notificationRefreshEvent))
}
