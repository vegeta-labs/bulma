import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built to static files served by the app; no inline scripts (CSP script-src 'self').
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
})
