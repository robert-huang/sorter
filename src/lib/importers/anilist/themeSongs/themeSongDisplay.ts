import type { MediaThemeSongRow, ThemeSongType } from './types';

export const THEME_SONG_SECTION_LABEL: Record<ThemeSongType, string> = {
  Opening: 'Openings',
  Ending: 'Endings',
  Insert: 'Inserts',
};

export function groupThemeRowsByType(
  rows: readonly MediaThemeSongRow[],
): Record<ThemeSongType, MediaThemeSongRow[]> {
  const groups: Record<ThemeSongType, MediaThemeSongRow[]> = {
    Opening: [],
    Ending: [],
    Insert: [],
  };
  for (const row of rows) {
    groups[row.type].push(row);
  }
  return groups;
}

/** Left-column badge: OP, OP2, ED, IN, etc. */
export function themeSongTypeBadge(row: MediaThemeSongRow): string {
  if (row.type === 'Insert') {
    return 'IN';
  }
  if (row.songKey) {
    const key = row.songKey.trim();
    if (row.type === 'Opening' && /^OP\d*$/i.test(key)) {
      return key.toUpperCase();
    }
    if (row.type === 'Ending' && /^ED\d*$/i.test(key)) {
      return key.toUpperCase();
    }
  }
  if (row.type === 'Opening') {
    return row.sortOrder === 0 ? 'OP' : `OP${row.sortOrder + 1}`;
  }
  return row.sortOrder === 0 ? 'ED' : `ED${row.sortOrder + 1}`;
}

/**
 * Episode line for inserts from AniPlaylist `song_key` (e.g. "IN ep 12" → "ep 12").
 * Falls back to MAL episode text when present.
 */
export function themeSongInsertEpisodeLine(row: MediaThemeSongRow): string | null {
  if (row.type !== 'Insert') {
    return null;
  }
  if (row.songKey) {
    const key = row.songKey.trim();
    const match = /^IN\s+(.+)$/i.exec(key);
    if (match) {
      return match[1].trim();
    }
  }
  if (row.malEpisodes) {
    return row.malEpisodes;
  }
  return null;
}
