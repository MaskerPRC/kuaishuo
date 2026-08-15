import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

// Two entry points, one bundle each:
//   index.html   — the console (history / stats / meetings / settings)
//   overlay.html — the floating strip that lives above the taskbar
//
// They are separate documents rather than routes on purpose: the overlay runs
// in a non-activating, always-on-top BrowserWindow whose renderer owns the mic
// for the whole session, and it must not be torn down or re-laid-out when the
// user navigates the console.
export default defineConfig({
  plugins: [vue()],
  base: './',
  server: { port: 5177, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: here('index.html'),
        overlay: here('overlay.html'),
      },
    },
  },
})
