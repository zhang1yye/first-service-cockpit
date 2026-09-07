import { Component, lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import { cockpitSso, getUser, isLoggedIn, refreshSession } from './lib/api'
import { reportClientError } from './lib/clientErrorReporter'
import { accessibleRoutes, canAccessPath, readablePermissions, shouldForcePasswordChange } from './lib/permissions'
import { loadRoute } from './lib/routePreload'

const chunkRetryKey = 'first-service:chunk-retry'

function isChunkLoadError(error) {
  const message = String(error?.message || '')
  return error?.name === 'ChunkLoadError' || /Failed to fetch dynamically imported module|Loading chunk|Importing a module script failed/i.test(message)
}

function lazyRoute(loader) {
  return lazy(async () => {
    try {
      const module = await loader()
      sessionStorage.removeItem(chunkRetryKey)
      return module
    } catch (error) {
      if (isChunkLoadError(error) && sessionStorage.getItem(chunkRetryKey) !== '1') {
        sessionStorage.setItem(chunkRetryKey, '1')
        window.location.reload()
      }
      throw error
    }
  })
}

const HomeView = lazyRoute(() => loadRoute('/'))
const LoginView = lazyRoute(() => loadRoute('/login'))
const SubmitView = lazyRoute(() => loadRoute('/submit'))
const ReviewView = lazyRoute(() => loadRoute('/review'))
const ProposalDetailView = lazyRoute(() => loadRoute('/review/:id'))
const BotsView = lazyRoute(() => loadRoute('/bots'))
const UsersView = lazyRoute(() => loadRoute('/users'))
const KnowledgeView = lazyRoute(() => loadRoute('/knowledge'))
const RulesView = lazyRoute(() => loadRoute('/rules'))
const LogsView = lazyRoute(() => loadRoute('/logs'))
const StatsView = lazyRoute(() => loadRoute('/stats'))
const SettingsView = lazyRoute(() => loadRoute('/settings'))
const ChangePasswordView = lazyRoute(() => loadRoute('/change-password'))

function PageLoading() {
  return (
    <div className="grid min-h-[240px] place-items-center p-6">
      <div role="status" aria-live="polite" className="rounded-lg border border-blue-500/20 bg-slate-950/80 px-5 py-4 text-sm text-blue-100 shadow-cyan">
        正在加载页面...
      </div>
    </div>
  )
}

class RouteErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('页面资源加载失败', error)
    reportClientError('react-boundary', error?.message || 'React 页面渲染异常', {
      source: 'RouteErrorBoundary',
      stack: [error?.stack, info?.componentStack].filter(Boolean).join('\n\n')
    })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="grid min-h-[320px] place-items-center p-6" role="alert" aria-live="assertive" aria-labelledby="route-error-title">
        <div className="w-full max-w-md rounded-lg border border-blue-500/20 bg-slate-950/85 p-6 text-center shadow-cyan">
          <div id="route-error-title" className="text-lg font-semibold text-blue-100">页面资源需要刷新</div>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            系统刚刚更新过，当前浏览器可能还保留了旧页面资源。刷新后会载入最新版本。
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            title="重新加载页面资源，载入最新版本"
            aria-label="重新加载页面资源，载入最新版本"
            className="mt-5 rounded-lg border border-blue-300/40 bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            重新加载
          </button>
        </div>
      </div>
    )
  }
}


function CockpitSsoGate({ children }) {
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('sso')
    if (!token) {
      setChecked(true)
      return
    }

    cockpitSso(token)
      .then(() => {
        params.delete('sso')
        const cleanSearch = params.toString()
        const normalizedPathname = window.location.pathname.replace(/\/index\.html$/, '/')
        const cleanPath = `${normalizedPathname}${cleanSearch ? `?${cleanSearch}` : ''}${window.location.hash || ''}`
        window.location.replace(cleanPath)
      })
      .catch(() => {
        window.location.href = '/'
      })
  }, [])

  if (!checked) {
    return <div className="min-h-screen grid place-items-center p-6 text-sm text-blue-100">正在通过驾驶舱进入研发小组审核系统...</div>
  }
  return children
}

// 认证守卫
function RequireAuth({ children }) {
  const location = useLocation()
  const [sessionChecked, setSessionChecked] = useState(false)
  const [sessionUser, setSessionUser] = useState(() => getUser())
  const [sessionError, setSessionError] = useState('')

  useEffect(() => {
    let active = true
    if (!isLoggedIn()) return

    setSessionChecked(false)
    setSessionError('')
    refreshSession()
      .then(() => {
        if (active) setSessionUser(getUser())
      })
      .catch(error => {
        if (active && isLoggedIn()) setSessionError(error?.message || '登录状态校验失败')
      })
      .finally(() => {
        if (active) setSessionChecked(true)
      })

    return () => {
      active = false
    }
  }, [])

  if (!isLoggedIn()) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (!sessionChecked) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div role="status" aria-live="polite" className="rounded-lg border border-blue-500/20 bg-slate-950/80 px-5 py-4 text-sm text-blue-100 shadow-cyan">
          正在校验登录状态...
        </div>
      </div>
    )
  }

  if (sessionError) {
    return (
      <div className="min-h-screen grid place-items-center p-6" role="alert" aria-live="assertive">
        <div className="w-full max-w-md rounded-lg border border-amber-400/30 bg-slate-950/90 p-6 text-center shadow-cyan">
          <div className="text-lg font-semibold text-amber-100">登录状态暂无法确认</div>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            {sessionError}。为避免使用过期权限，已暂停进入业务页面。
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-lg border border-amber-300/40 bg-amber-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            重新校验
          </button>
        </div>
      </div>
    )
  }

  const currentUser = sessionUser || getUser()
  if (shouldForcePasswordChange(currentUser) && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" state={{ from: `${location.pathname}${location.search}${location.hash}` }} replace />
  }
  if (!canAccessPath(currentUser, location.pathname)) {
    return <AccessDenied />
  }
  return children
}

function AccessDenied() {
  const user = getUser()
  const routes = accessibleRoutes(user).filter(route => route.path !== window.location.pathname)
  const permissions = readablePermissions(user)

  return (
    <div className="min-h-screen grid place-items-center p-6">
      <div className="w-full max-w-xl rounded-lg border border-blue-500/20 bg-slate-950/80 p-6 text-center shadow-cyan" role="alert" aria-live="assertive" aria-labelledby="access-denied-title">
        <div id="access-denied-title" className="text-xl font-bold text-blue-100">无权限访问</div>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          当前账号没有访问该页面的权限。账号角色：{user?.role || '未识别'}；权限范围：{permissions.join('、') || '无权限'}。
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {routes.slice(0, 5).map(route => (
            <a key={route.path} href={route.path} className="inline-flex rounded-lg border border-blue-400/40 bg-blue-600/20 px-4 py-2 text-sm text-blue-100 transition hover:bg-blue-600/30">
              {route.label}
            </a>
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-500">如需开通更多入口，请由管理员在人员管理或角色权限矩阵中调整。</p>
      </div>
    </div>
  )
}

function NotFound() {
  const user = getUser()
  const routes = accessibleRoutes(user)

  return (
    <div className="min-h-[420px] grid place-items-center p-6">
      <div className="w-full max-w-xl rounded-lg border border-blue-500/20 bg-slate-950/80 p-6 text-center shadow-cyan" role="status" aria-live="polite" aria-labelledby="not-found-title">
        <div className="text-sm font-semibold text-blue-300">404</div>
        <div id="not-found-title" className="mt-2 text-xl font-bold text-blue-100">页面不存在或入口已调整</div>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          当前访问的地址没有匹配到系统页面。可以返回工作台，或进入当前账号可访问的功能入口。
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {routes.slice(0, 6).map(route => (
            <a key={route.path} href={route.path} className="inline-flex rounded-lg border border-blue-400/40 bg-blue-600/20 px-4 py-2 text-sm text-blue-100 transition hover:bg-blue-600/30">
              {route.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

// 主布局: 侧边栏 + 顶栏 + 内容
function AppLayout() {
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [authVersion, setAuthVersion] = useState(0)
  const [permissionMessage, setPermissionMessage] = useState('')

  useEffect(() => {
    const refreshAuth = () => {
      setAuthVersion(value => value + 1)
      if (shouldForcePasswordChange(getUser()) && window.location.pathname !== '/change-password') {
        navigate('/change-password', { replace: true })
        return
      }
      if (!canAccessPath(getUser(), window.location.pathname)) {
        navigate('/', { replace: true })
      }
    }
    const showPermissionDenied = (event) => {
      setPermissionMessage(event.detail?.message || '当前账号无权限执行该操作')
      window.clearTimeout(showPermissionDenied.timer)
      showPermissionDenied.timer = window.setTimeout(() => setPermissionMessage(''), 3500)
    }

    window.addEventListener('auth:user-updated', refreshAuth)
    window.addEventListener('auth:permission-denied', showPermissionDenied)
    return () => {
      window.removeEventListener('auth:user-updated', refreshAuth)
      window.removeEventListener('auth:permission-denied', showPermissionDenied)
      window.clearTimeout(showPermissionDenied.timer)
    }
  }, [navigate])

  useEffect(() => {
    if (!sidebarOpen) return

    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSidebarOpen(false)
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [sidebarOpen])

  return (
    <div className="aph-app-shell flex min-h-screen relative z-[1]">
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-[80] -translate-y-20 rounded-lg border border-blue-300/50 bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-cyan transition focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-blue-200"
      >
        跳到主内容
      </a>
      <Sidebar key={`sidebar-${authVersion}`} />
      {/* 移动端侧边栏遮罩 */}
      {sidebarOpen && (
        <>
          <button
            type="button"
            className="lg:hidden fixed inset-0 z-40 bg-black/60"
            onClick={() => setSidebarOpen(false)}
            title="关闭移动端侧边菜单"
            aria-label="关闭移动端侧边菜单"
          />
          <Sidebar key={`mobile-sidebar-${authVersion}`} variant="mobile" onNavigate={() => setSidebarOpen(false)} />
        </>
      )}
      <main className="aph-main flex-1 min-w-0 flex flex-col">
        <Topbar key={`topbar-${authVersion}`} onMenuClick={() => setSidebarOpen(true)} />
        <div id="main-content" tabIndex={-1} className="aph-main-content flex-1 p-5 outline-none">
          {permissionMessage && (
            <div role="alert" aria-live="assertive" className="mb-4 rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-100">
              {permissionMessage}
            </div>
          )}
          <RouteErrorBoundary>
            <Suspense fallback={<PageLoading />}>
              <Routes>
                <Route path="/" element={<HomeView />} />
                <Route path="/submit" element={<SubmitView />} />
                <Route path="/review" element={<ReviewView />} />
                <Route path="/review/:id" element={<ProposalDetailView />} />
                <Route path="/bots" element={<BotsView />} />
                <Route path="/users" element={<UsersView />} />
                <Route path="/knowledge" element={<KnowledgeView />} />
                <Route path="/rules" element={<RulesView />} />
                <Route path="/stats" element={<StatsView />} />
                <Route path="/logs" element={<LogsView />} />
                <Route path="/settings" element={<SettingsView />} />
                <Route path="/change-password" element={<ChangePasswordView />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </RouteErrorBoundary>
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <div className="min-h-screen text-slate-100 overflow-hidden">
      <div className="relative">
        <BrowserRouter basename={window.location.pathname.startsWith('/review-system') ? '/review-system' : undefined}>
          <CockpitSsoGate>
            <RouteErrorBoundary>
              <Suspense fallback={<PageLoading />}>
                <Routes>
                <Route path="/login" element={<LoginView />} />
                <Route
                  path="/*"
                  element={
                    <RequireAuth>
                      <AppLayout />
                    </RequireAuth>
                  }
                />
              </Routes>
              </Suspense>
            </RouteErrorBoundary>
          </CockpitSsoGate>
        </BrowserRouter>
      </div>
    </div>
  )
}
