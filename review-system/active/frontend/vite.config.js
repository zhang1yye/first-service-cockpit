import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const buildVersion = `v${pkg.version}`
const buildTime = new Date().toISOString()
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001'

export default defineConfig({
  base: '/review-system/',
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(buildVersion),
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(buildTime)
  },
  build: {
    // 生产构建无需逐个计算 gzip 报表，避免在低配发布机上拖慢候选生成。
    reportCompressedSize: false
  },
  server: {
    proxy: {
      '/api': apiProxyTarget
    }
  }
})
