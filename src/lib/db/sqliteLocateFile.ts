/**
 * Resolve sqlite-wasm asset URLs for bundled workers.
 * A custom locateFile must map every file sqlite loads — not only `.wasm`.
 */
import opfsProxyUrl from '../../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3-opfs-async-proxy.js?url';
import sqlite3Worker1Url from '../../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3-worker1.mjs?url';
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';

const SQLITE_ASSET_URLS: Readonly<Record<string, string>> = {
  'sqlite3.wasm': wasmUrl,
  'sqlite3-opfs-async-proxy.js': opfsProxyUrl,
  'sqlite3-worker1.mjs': sqlite3Worker1Url,
  'sqlite3-worker1.js': sqlite3Worker1Url,
};

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Emscripten / sqlite-wasm locateFile hook. */
export function locateSqliteFile(file: string, prefix = ''): string {
  const direct = SQLITE_ASSET_URLS[file];
  if (direct) {
    return direct;
  }
  const base = basename(file);
  const byBase = SQLITE_ASSET_URLS[base];
  if (byBase) {
    return byBase;
  }
  try {
    return new URL(file, import.meta.url).href;
  } catch {
    return `${prefix}${file}`;
  }
}
