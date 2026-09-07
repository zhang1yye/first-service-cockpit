import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ShieldAlert, ShieldCheck, Home, FileText, ClipboardList, Bot, Settings, ChartNoAxesCombined, ListChecks, Wrench, UsersRound, BookText } from '../lib/lucide.js'
import firstServiceLogo from '../assets/brand/first-service-logo-2026-transparent.png'
import { appVersion } from '../lib/appVersion'
import { api, getUser } from '../lib/api'
import { preloadReviewCharts } from '../lib/chartPreload'
import { accessibleRoutes, hasPermission } from '../lib/permissions'
import { preloadRoute, schedulePreloadRoutes } from '../lib/routePreload'

const navIcons = {
  '/': Home,
  '/submit': FileText,
  '/review': ClipboardList,
  '/bots': Bot,
  '/users': UsersRound,
  '/knowledge': BookText,
  '/rules': Settings,
  '/stats': ChartNoAxesCombined,
  '/logs': ListChecks,
  '/settings': Wrench
}

export default function Sidebar({ variant = 'desktop', onNavigate }) {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const user = getUser()
  const [serviceStatus, setServiceStatus] = useState('checking')
  const canViewSecurityOps = (hasPermission(user, 'manageUsers') || hasPermission(user, 'manageSystem')) && hasPermission(user, 'viewLogs')
  const visibleNavItems = accessibleRoutes(user).map(route => ({ ...route, Icon: navIcons[route.path] || Home }))
  const preloadPathKey = visibleNavItems.map(item => item.path).join('|')
  const asideClass = variant === 'mobile'
    ? 'aph-sidebar aph-sidebar-mobile fixed left-0 top-0 bottom-0 z-50 w-72 flex flex-col lg:hidden shadow-2xl'
    : 'aph-sidebar aph-sidebar-desktop hidden lg:flex flex-col'
  const go = (path) => {
    navigate(path)
    onNavigate?.()
  }
  const warmRoute = (path) => {
    preloadRoute(path)
    if (path === '/stats') preloadReviewCharts()
  }
  const navActionLabel = (label, path, active) => {
    const target = path === '/stats' ? `${label}统计页` : label
    return `${active ? '当前页面：' : '打开'}${target}`
  }
  const securityActionLabel = pathname === '/stats' && search.includes('focus=security')
    ? '当前页面：账号安全分析'
    : '打开账号安全分析，查看默认密码、需改密、登录锁定和安全拦截统计'

  useEffect(() => {
    const nextRoutes = preloadPathKey
      .split('|')
      .filter(path => path !== pathname)
    return schedulePreloadRoutes(nextRoutes)
  }, [pathname, preloadPathKey])

  useEffect(() => {
    let active = true
    const checkHealth = async () => {
      try {
        const health = await api.get('/health')
        if (active) setServiceStatus(health?.ok === true ? 'healthy' : 'error')
      } catch {
        if (active) setServiceStatus('error')
      }
    }
    checkHealth()
    const timer = window.setInterval(checkHealth, 60_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const serviceHealthy = serviceStatus === 'healthy'
  const serviceStatusText = serviceHealthy
    ? '运行正常'
    : serviceStatus === 'error'
      ? '连接异常'
      : '正在检测'

  return (
    <aside className={asideClass} aria-label={variant === 'mobile' ? '移动端主导航' : '主导航'}>
      <div className="aph-sidebar-brand h-14 px-4 flex items-center gap-3">
        <div className="relative shrink-0">
          <img src={firstServiceLogo} alt="第一服务" className="relative h-10 w-20 object-contain" />
        </div>
        <div className="min-w-0 text-left">
          <div className="truncate text-[15px] font-semibold leading-tight text-[#ecf3f8]">第一服务研发小组审核系统</div>
          <div className="text-[11px] text-[#9aadb8]">驾驶舱统一入口 · 专业审核工作台</div>
        </div>
      </div>
      <nav className="aph-sidebar-nav p-3 space-y-2 flex-1" aria-label={variant === 'mobile' ? '移动端功能入口' : '功能入口'}>
        {visibleNavItems.map(({ label, path, Icon }) => {
          const securityFocusActive = canViewSecurityOps && pathname === '/stats' && search.includes('focus=security')
          const active = path === '/stats'
            ? pathname === '/stats' && !securityFocusActive
            : pathname === path || (path !== '/' && pathname.startsWith(path))
          return (
            <button
              type="button"
              key={path}
              onClick={() => go(path)}
              onFocus={() => warmRoute(path)}
              onMouseEnter={() => warmRoute(path)}
              title={navActionLabel(label, path, active)}
              aria-label={navActionLabel(label, path, active)}
              aria-current={active ? 'page' : undefined}
              className={`aph-nav-item w-full flex items-center gap-3 px-3 h-10 text-sm transition-all ${
                active
                  ? 'aph-nav-item-active font-semibold'
                  : ''
              }`}
            >
              <Icon size={19} aria-hidden="true" />{label}
            </button>
          )
        })}
        {canViewSecurityOps && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => go('/stats?focus=security')}
              onFocus={() => warmRoute('/stats')}
              onMouseEnter={() => warmRoute('/stats')}
              title={securityActionLabel}
              aria-label={securityActionLabel}
              aria-current={pathname === '/stats' && search.includes('focus=security') ? 'page' : undefined}
              className={`aph-nav-item aph-nav-security w-full flex items-center gap-3 px-3 h-10 text-sm transition-all ${
                pathname === '/stats' && search.includes('focus=security')
                  ? 'aph-nav-item-active'
                  : ''
              }`}
            >
              <ShieldAlert size={19} aria-hidden="true" />
              账号安全分析
            </button>
          </div>
        )}
      </nav>
      <div className="p-4 text-sm text-[#9aadb8] border-t border-[#253447]/70">
        <div className="flex items-center gap-3 mb-6">
          {serviceHealthy
            ? <ShieldCheck className="text-[#00ccf9]" aria-hidden="true" />
            : <ShieldAlert className={serviceStatus === 'error' ? 'text-amber-300' : 'text-slate-400'} aria-hidden="true" />}
          <div>系统状态<br /><span role="status" aria-live="polite" className={serviceHealthy ? 'text-emerald-400' : serviceStatus === 'error' ? 'text-amber-300' : 'text-slate-400'}>● {serviceStatusText}</span></div>
        </div>
        <div>版本：{appVersion}</div>
      </div>
    </aside>
  )
}
