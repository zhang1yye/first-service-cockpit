(() => {
  'use strict'

  const PAYMENT_ROUTE_CLASS = 'aph-payment-route'

  function syncPaymentRoute() {
    document.body?.classList.toggle(PAYMENT_ROUTE_CLASS, window.location.pathname === '/payment')
  }

  function scheduleSync() {
    window.requestAnimationFrame(syncPaymentRoute)
  }

  window.addEventListener('DOMContentLoaded', syncPaymentRoute, { once: true })
  window.addEventListener('popstate', scheduleSync)
  window.addEventListener('cockpit:navigation', scheduleSync)
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (link && new URL(link.href, window.location.href).origin === window.location.origin) {
      window.setTimeout(syncPaymentRoute, 0)
    }
  }, true)

  if (document.readyState !== 'loading') syncPaymentRoute()
})()
