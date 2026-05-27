import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' so the built dist/ works both when served over http(s)://
// and when opened directly as a file:// URL (double-click index.html).
export default defineConfig({
  plugins: [react()],
  base: './',
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dbSmoke: resolve(__dirname, 'db-smoke.html'),
      },
    },
  },
  worker: {
    format: 'es',
  },
});
