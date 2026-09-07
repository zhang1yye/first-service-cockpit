const routeLoaders = {
  '/': () => import('../views/HomeView'),
  '/submit': () => import('../views/SubmitView'),
  '/review': () => import('../views/ReviewView'),
  '/review/:id': () => import('../views/ProposalDetailView'),
  '/bots': () => import('../views/BotsView'),
  '/users': () => import('../views/UsersView'),
  '/knowledge': () => import('../views/KnowledgeView'),
  '/rules': () => import('../views/RulesView'),
  '/stats': () => import('../views/StatsView'),
  '/logs': () => import('../views/LogsView'),
  '/settings': () => import('../views/SettingsView'),
  '/change-password': () => import('../views/ChangePasswordView'),
  '/login': () => import('../views/LoginView')
}

const preloadCache = new Map()

function shouldSkipIdlePreload() {
  if (typeof navigator === 'undefined') return false
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  if (!connection) return false
  return connection.saveData || ['slow-2g', '2g'].includes(connection.effectiveType)
}

export function loadRoute(path) {
  return routeLoaders[path]?.()
}

export function preloadRoute(path) {
  const loader = routeLoaders[path]
  if (!loader) return null
  if (!preloadCache.has(path)) {
    preloadCache.set(path, loader().catch(error => {
      preloadCache.delete(path)
      throw error
    }))
  }
  return preloadCache.get(path)
}

export function schedulePreloadRoutes(paths, { delay = 1200, limit = 3 } = {}) {
  if (typeof window === 'undefined') return () => {}
  if (shouldSkipIdlePreload()) return () => {}
  const targets = [...new Set(paths)].filter(path => routeLoaders[path]).slice(0, limit)
  if (targets.length === 0) return () => {}

  let idleId = null
  const timerId = window.setTimeout(() => {
    const run = () => targets.forEach(path => preloadRoute(path))
    if ('requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(run, { timeout: 2500 })
    } else {
      run()
    }
  }, delay)

  return () => {
    window.clearTimeout(timerId)
    if (idleId && 'cancelIdleCallback' in window) {
      window.cancelIdleCallback(idleId)
    }
  }
}
