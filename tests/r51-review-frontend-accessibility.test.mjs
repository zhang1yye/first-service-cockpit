import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const home = fs.readFileSync(path.join(root, 'review-system/active/frontend/src/views/HomeView.jsx'), 'utf8')
const style = fs.readFileSync(path.join(root, 'review-system/active/frontend/src/style.css'), 'utf8')
const charts = fs.readFileSync(path.join(root, 'review-system/active/frontend/src/components/charts/ReviewCharts.jsx'), 'utf8')
const submit = fs.readFileSync(path.join(root, 'review-system/active/frontend/src/views/SubmitView.jsx'), 'utf8')
const businessTime = fs.readFileSync(path.join(root, 'review-system/active/frontend/src/lib/businessTime.js'), 'utf8')

test('审核首页两个视图具有完整 tab 语义和可分享 URL 状态', () => {
  assert.match(home, /role="tablist"/)
  assert.match(home, /aria-label="首页工作视图"/)
  assert.match(home, /id="home-tab-review"/)
  assert.match(home, /id="home-tab-ops"/)
  assert.match(home, /role="tab"/)
  assert.match(home, /aria-selected=\{homeMode === 'review'\}/)
  assert.match(home, /aria-selected=\{homeMode === 'ops'\}/)
  assert.equal((home.match(/aria-controls="home-panel"/g) || []).length, 2)
  assert.match(home, /role="tabpanel"/)
  assert.match(home, /aria-labelledby=\{`home-tab-\$\{homeMode\}`\}/)
})

test('无运行权限账号即使携带 mode=ops 也回退到审核视图', () => {
  assert.match(home, /const canAccessOps = canManageSystem \|\| canViewLogs \|\| canManageUsers/)
  assert.match(home, /const homeMode = canAccessOps && searchParams\.get\('mode'\) === 'ops' \? 'ops' : 'review'/)
  assert.match(home, /const safeMode = mode === 'ops' && canAccessOps \? 'ops' : 'review'/)
  assert.match(home, /const visibleHomeModes = \['review', \.\.\.canAccessOps \? \['ops'\] : \[\]\]/)
  assert.match(home, /\{canAccessOps && \(/)
})

test('tab 支持 ArrowLeft ArrowRight Home End 并将焦点移到新选项', () => {
  assert.match(home, /const homeTabRefs = useRef\(\{\}\)/)
  assert.match(home, /const visibleHomeModes = \['review', \.\.\.canAccessOps \? \['ops'\] : \[\]\]/)
  assert.match(home, /event\.key === 'ArrowRight'/)
  assert.match(home, /event\.key === 'ArrowLeft'/)
  assert.match(home, /event\.key === 'Home'/)
  assert.match(home, /event\.key === 'End'/)
  assert.match(home, /homeTabRefs\.current\[nextMode\]\?\.focus\(\)/)
  assert.match(home, /tabIndex=\{homeMode === 'review' \? 0 : -1\}/)
  assert.match(home, /tabIndex=\{homeMode === 'ops' \? 0 : -1\}/)
})

test('移动端审核队列滚动区可聚焦、有语义且提供操作提示', () => {
  assert.match(home, /className="review-table-scroll overflow-x-auto"/)
  assert.match(home, /tabIndex=\{0\}/)
  assert.match(home, /role="region"/)
  assert.match(home, /aria-label="方案审核队列表格，可横向滚动"/)
  assert.match(home, /aria-describedby="review-table-scroll-help"/)
  assert.match(home, /id="review-table-scroll-help"/)
})

test('工作视图仅根据真实业务时间显示数据新鲜度', () => {
  assert.match(home, /import \{ latestBusinessFreshness \} from '\.\.\/lib\/businessTime'/)
  assert.match(businessTime, /item\.updatedAt \|\| item\.createdAt/)
  assert.match(businessTime, /aiTraceStats\.latestAt/)
  assert.match(businessTime, /executionLogs\.map\(item => \(\{ source: '执行动作', value: item\.at \}\)\)/)
  assert.match(businessTime, /text: '暂无记录'/)
  assert.match(businessTime, /`最近业务记录 \$\{formatBusinessTimestamp\(latest\.timestamp\)\} · \$\{stale \? '已超过24小时' : '24小时内'\}/)
  assert.match(businessTime, /localMatch/)
  assert.match(home, /role="status"/)
  assert.match(home, /aria-live="polite"/)
  assert.match(home, /data-review-data-freshness=/)
})

test('浅色 APH 覆写使用可读文本、状态和操作色，并保证基础触摸目标', () => {
  assert.match(style, /--aph-text-muted:\s*#626870/)
  assert.match(style, /--aph-link:\s*#9b1724/)
  assert.match(style, /--aph-success:\s*#176b45/)
  assert.match(style, /--aph-warning:\s*#8a4d08/)
  assert.match(style, /--aph-violet:\s*#6c3a91/)
  assert.match(style, /\.aph-main-content button:not\(\.aph-nav-item\),\s*\.aph-main-content a[^\{]*\{[^}]*min-height:\s*24px/s)
  assert.match(style, /\.review-table-scroll:focus-visible/)
  assert.match(style, /\.review-home-intro-bg/)
  assert.match(style, /\.aph-sidebar\s*\{[^}]*color:\s*var\(--aph-text-muted\)/s)
  assert.match(style, /\.aph-nav-security\s*\{\s*color:\s*var\(--aph-warning\)/)
  assert.match(style, /\[class\*="text-yellow-"\]\s*\{\s*color:\s*var\(--aph-warning\)/)
  assert.match(style, /\.aph-main-content \.opacity-80\s*\{\s*opacity:\s*1/)
  assert.match(style, /\.aph-main-content \.opacity-70\s*\{\s*opacity:\s*1/)
  assert.match(style, /\[class\*="text-sky-"\]\s*\{\s*color:\s*var\(--aph-link\)/)
  assert.match(style, /\[class\*="text-fuchsia-"\]\s*\{\s*color:\s*var\(--aph-violet\)/)
})

test('全部分析图使用文本摘要，视觉 SVG 不重复进入可访问树', () => {
  assert.match(charts, /function AccessibleChart/)
  assert.match(charts, /<p className="sr-only">\{summary\}<\/p>/)
  assert.match(charts, /<div className="h-full w-full" aria-hidden="true">\{children\}<\/div>/)
  assert.match(charts, /StatusPieChart[\s\S]*rootTabIndex=\{-1\}/)
  assert.match(charts, /ProfessionalPieChart[\s\S]*rootTabIndex=\{-1\}/)
  assert.ok((charts.match(/isAnimationActive=\{false\}/g) || []).length >= 7)
})

test('方案类型单选组不混用 button 按压语义', () => {
  const radioBlock = submit.match(/role="radiogroup"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || ''
  assert.match(radioBlock, /role="radio"/)
  assert.match(radioBlock, /aria-checked=/)
  assert.doesNotMatch(radioBlock, /aria-pressed=/)
})
