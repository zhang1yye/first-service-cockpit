import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'))
}

test('前端路由依赖固定在已修复版本', async () => {
  const manifest = await json('review-system/active/frontend/package.json')
  const lock = await json('review-system/active/frontend/package-lock.json')

  assert.equal(manifest.dependencies['react-router-dom'], '7.18.2')
  assert.equal(lock.packages['node_modules/react-router-dom'].version, '7.18.2')
  assert.equal(lock.packages['node_modules/react-router'].version, '7.18.2')
})

test('审核前端只从受控图标入口导入，生产构建不会扫描完整图标库', async () => {
  const sourceFiles = [
    'components/CopyFallbackDialog.jsx',
    'components/Sidebar.jsx',
    'components/Topbar.jsx',
    'views/BotsView.jsx',
    'views/ChangePasswordView.jsx',
    'views/HomeView.jsx',
    'views/KnowledgeView.jsx',
    'views/LoginView.jsx',
    'views/LogsView.jsx',
    'views/ProposalDetailView.jsx',
    'views/ReviewView.jsx',
    'views/RulesView.jsx',
    'views/SettingsView.jsx',
    'views/StatsView.jsx',
    'views/SubmitView.jsx',
    'views/UsersView.jsx'
  ]

  for (const relative of sourceFiles) {
    const source = await readFile(new URL(`review-system/active/frontend/src/${relative}`, root), 'utf8')
    assert.doesNotMatch(source, /from ['"]lucide-react['"]/, `${relative} 不得恢复总入口导入`)
    assert.match(source, /from ['"]\.\.\/lib\/lucide\.js['"]/, `${relative} 必须使用受控图标入口`)
  }

  const entry = await readFile(new URL('review-system/active/frontend/src/lib/lucide.js', root), 'utf8')
  assert.equal((entry.match(/^export \{ default as /gm) || []).length, 56)
  assert.doesNotMatch(entry, /from ['"]lucide-react['"]/, '受控入口不得再次导入总入口')
})

test('审核 API 生产依赖使用安全固定版本', async () => {
  const manifest = await json('review-system/active/backend/package.json')
  const lock = await json('review-system/active/backend/package-lock.json')

  assert.equal(manifest.dependencies.multer, '2.2.0')
  assert.equal(manifest.dependencies.morgan, '1.11.0')
  assert.equal(manifest.dependencies.xlsx, 'file:vendor/xlsx-0.20.3.tgz')
  assert.equal(manifest.overrides['body-parser'], '2.3.0')
  assert.equal(lock.packages['node_modules/multer'].version, '2.2.0')
  assert.equal(lock.packages['node_modules/morgan'].version, '1.11.0')
  assert.equal(lock.packages['node_modules/body-parser'].version, '2.3.0')
  assert.equal(lock.packages['node_modules/xlsx'].version, '0.20.3')
})

test('Hermes 网关依赖和 body-parser 覆盖版本固定', async () => {
  const manifest = await json('review-system/active/hermes/package.json')
  const lock = await json('review-system/active/hermes/package-lock.json')

  assert.equal(manifest.dependencies.express, '5.2.1')
  assert.equal(manifest.dependencies.morgan, '1.11.0')
  assert.equal(manifest.overrides['body-parser'], '2.3.0')
  assert.equal(lock.packages['node_modules/body-parser'].version, '2.3.0')
  assert.equal(lock.packages['node_modules/morgan'].version, '1.11.0')
})

test('SheetJS 官方发布包已经本地固化并通过哈希门禁', async () => {
  const tarball = await readFile(new URL('review-system/active/backend/vendor/xlsx-0.20.3.tgz', root))
  const digest = createHash('sha256').update(tarball).digest('hex')

  assert.equal(digest, '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8')
})
