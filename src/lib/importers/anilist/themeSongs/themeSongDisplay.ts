import type { ThemeSongNameDisplayMode } from '../../../spotify/themeSongDisplayPreferences';
import type { MediaThemeSongRow, ThemeSongType } from './types';

const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

export function containsCjkScript(text: string): boolean {
  return CJK_CHAR_RE.test(text);
}

function cjkCharCount(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (CJK_CHAR_RE.test(ch)) {
      count += 1;
    }
  }
  return count;
}

/** Pick the candidate with the most CJK characters (best-effort native label). */
export function pickBestNativeCandidate(candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (!trimmed || !containsCjkScript(trimmed)) {
      continue;
    }
    const score = cjkCharCount(trimmed);
    if (score > bestScore) {
      bestScore = score;
      best = trimmed;
    }
  }
  return best;
}

/** Extract native text from MAL-style parentheticals, e.g. `Kanade (奏（かなで）)`. */
export function extractNativeFromMalText(text: string): string | null {
  const candidates: string[] = [];
  const parenRe = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = parenRe.exec(text)) !== null) {
    const inner = match[1]?.trim();
    if (inner && containsCjkScript(inner)) {
      candidates.push(inner);
    }
  }
  return pickBestNativeCandidate(candidates);
}

/** Strip trailing parenthetical native titles from MAL strings. */
export function stripNativeParenthetical(text: string): string {
  let result = text.trim();
  while (result.length > 0) {
    const match = /^(.+?)\s*\(([^)]*)\)\s*$/.exec(result);
    if (!match || !containsCjkScript(match[2] ?? '')) {
      break;
    }
    result = match[1].trim();
  }
  return result;
}

function isCvCreditLine(text: string): boolean {
  const trimmed = text.trim();
  return /^CV\s*:/i.test(trimmed);
}

export function resolveThemeSongTitle(
  row: MediaThemeSongRow,
  mode: ThemeSongNameDisplayMode,
): string {
  const base = row.displayTitle?.trim() ?? '';
  if (!base) {
    return '';
  }
  if (mode === 'english') {
    return stripNativeParenthetical(base) || base;
  }

  const fromAni = row.aniTitles ? pickBestNativeCandidate(row.aniTitles) : null;
  if (fromAni) {
    return fromAni;
  }

  const malSource = row.malTitle ?? base;
  const fromMal = extractNativeFromMalText(malSource);
  if (fromMal) {
    return fromMal;
  }

  return stripNativeParenthetical(base) || base;
}

export function resolveThemeSongArtist(
  row: MediaThemeSongRow,
  mode: ThemeSongNameDisplayMode,
): string | null {
  const base = row.displayArtist?.trim() || null;
  if (mode === 'english') {
    return base;
  }

  const aniCandidates = (row.aniArtists ?? []).filter((name) => !isCvCreditLine(name));
  const fromAni = pickBestNativeCandidate(aniCandidates);
  if (fromAni) {
    return fromAni;
  }

  if (row.malArtist) {
    const fromMal = extractNativeFromMalText(row.malArtist);
    if (fromMal) {
      return fromMal;
    }
  }

  return base;
}

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
