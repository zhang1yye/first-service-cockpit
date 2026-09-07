import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5188,
    proxy: { '/api': process.env.VITE_API_PROXY || 'http://localhost:3001' },
  },
  build: { outDir: 'dist', sourcemap: false },
})
