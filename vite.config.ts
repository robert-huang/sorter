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
    // Workers must be separate files — inlining as data: URLs breaks SharedWorker.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dbSmoke: resolve(__dirname, 'db-smoke.html'),
        animeToAnime: resolve(__dirname, 'anime-to-anime.html'),
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        // Avoid .ts extension on emitted worker chunks (some servers MIME-map .ts → video/mp2t).
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
});
