import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The static demo pack (plan 05 §5.1): the same screens, with api.ts and browser.ts swapped for their static twins, so every
// answer comes from data/snapshot.js (a plain script loaded before the app) and nothing is sent. Relative base: the pack works
// under any folder (the site serves it at /bulma/demo/). Built by scripts/demo-build.ts, never by the normal build.
const web = (f: string) => fileURLToPath(new URL(`./src/web/${f}`, import.meta.url))

export default defineConfig({
  root: 'src/web',
  base: './',
  plugins: [
    react(),
    {
      name: 'demo-snapshot-script',
      transformIndexHtml: () => [{ tag: 'script', attrs: { src: './data/snapshot.js' }, injectTo: 'head' }],
    },
  ],
  resolve: {
    alias: [
      { find: /^\.\/api\.ts$/, replacement: web('static-api.ts') },
      { find: /^\.\/browser\.ts$/, replacement: web('static-browser.ts') },
    ],
  },
  build: { outDir: '../../dist-demo', emptyOutDir: true, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
})
