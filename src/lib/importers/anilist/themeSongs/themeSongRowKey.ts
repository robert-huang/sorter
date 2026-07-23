import type { MediaThemeSongRow } from './types';

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Stable id for a theme row — used for manual exclusions across refresh. */
export function themeSongRowKey(row: MediaThemeSongRow): string {
  if (row.songKey) {
    return `ani:${row.type}:${normalizeKey(row.songKey)}:${normalizeKey(row.displayTitle)}`;
  }
  if (row.malRaw) {
    return `mal:${row.type}:${normalizeKey(row.malRaw)}`;
  }
  return `row:${row.type}:${normalizeKey(row.displayTitle)}:${normalizeKey(row.displayArtist ?? '')}`;
}
