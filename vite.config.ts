import { resolve } from 'node:path';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Optional local dev/preview headers (cross-origin isolation; not required for OPFS SAH pool). */
const crossOriginIsolationHeaders = {
  // Allow OAuth popup → hosted callback page to keep window.opener for postMessage.
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  // credentialless: cross-origin isolation without breaking CDN images (AniList covers).
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

/**
 * AniPlaylist's Algolia key is referer-locked to aniplaylist.com. Browsers
 * cannot spoof Origin/Referer on fetch, so dev/preview proxy server-side.
 */
const aniplaylistAlgoliaProxy: ProxyOptions = {
  target: 'https://p4b7ht5p18-dsn.algolia.net',
  changeOrigin: true,
  secure: true,
  rewrite: () => '/1/indexes/*/queries',
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.setHeader('Origin', 'https://aniplaylist.com');
      proxyReq.setHeader('Referer', 'https://aniplaylist.com/');
    });
  },
};

// base: './' so the built dist/ works both when served over http(s)://
// and when opened directly as a file:// URL (double-click index.html).
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    headers: crossOriginIsolationHeaders,
    proxy: {
      '/api/aniplaylist/algolia': aniplaylistAlgoliaProxy,
    },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
    proxy: {
      '/api/aniplaylist/algolia': aniplaylistAlgoliaProxy,
    },
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Workers must be separate files — inlining as data: URLs breaks worker loading.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dbSmoke: resolve(__dirname, 'db-smoke.html'),
        animeToAnime: resolve(__dirname, 'anime-to-anime.html'),
        tools: resolve(__dirname, 'tools.html'),
        anilistOAuthCallback: resolve(__dirname, 'anilist-oauth-callback.html'),
        spotifyOAuthCallback: resolve(__dirname, 'spotify-oauth-callback.html'),
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
