#!/usr/bin/env node
/**
 * Run Vite with production Cloudflare worker URLs (same as GitHub Pages build).
 * Usage: node scripts/run-vite-with-workers.mjs [vite args...]
 *   npm run dev:workers
 *   npm run preview:workers
 */
import { spawn } from 'node:child_process';
import { ANIPLAYLIST_PROXY_URL, MAL_PROXY_URL } from './worker-urls.mjs';

const viteArgs = process.argv.slice(2);
const command = viteArgs[0] === 'preview' ? ['vite', 'preview', ...viteArgs.slice(1)] : ['vite', ...viteArgs];

const child = spawn('npx', command, {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_ANIPLAYLIST_PROXY_URL: ANIPLAYLIST_PROXY_URL,
    VITE_MAL_PROXY_URL: MAL_PROXY_URL,
  },
  shell: true,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
