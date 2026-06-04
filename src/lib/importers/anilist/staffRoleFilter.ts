/**
 * Read-time filter for production staff roles. AniList returns free-form
 * role strings on StaffEdge — there is no server-side filter on Media.staff.
 */

const DIRECTOR_PATTERNS = [
  'director',
  'series director',
  'chief animation director',
  'episode director',
];

const SOUND_DIRECTOR_PATTERNS = ['sound director'];

const CHARACTER_DESIGN_PATTERNS = [
  'character design',
  'original character design',
];

const MUSIC_PATTERNS = ['music'];

const THEME_SONG_PATTERNS = [
  'theme song performance',
  'theme song lyrics',
  'theme song composition',
];

function normalizeRole(role: string): string {
  return role.trim().toLowerCase();
}

function matchesAny(haystack: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => haystack.includes(p));
}

/** Chief Animation Director is director bucket, not character design. */
function isDirectorRole(normalized: string): boolean {
  return matchesAny(normalized, DIRECTOR_PATTERNS);
}

function isCharacterDesignRole(normalized: string): boolean {
  if (normalized.includes('chief animation director')) {
    return false;
  }
  return matchesAny(normalized, CHARACTER_DESIGN_PATTERNS);
}

/**
 * Whether a production credit role counts as a "key" production role for
 * sorter detail panel and anime-to-anime production hops (default).
 */
export function isKeyProductionRole(role: string | null | undefined): boolean {
  if (!role) {
    return false;
  }
  const n = normalizeRole(role);
  if (isDirectorRole(n)) {
    return true;
  }
  if (matchesAny(n, SOUND_DIRECTOR_PATTERNS)) {
    return true;
  }
  if (isCharacterDesignRole(n)) {
    return true;
  }
  if (matchesAny(n, MUSIC_PATTERNS)) {
    return true;
  }
  if (matchesAny(n, THEME_SONG_PATTERNS)) {
    return true;
  }
  return false;
}

export function filterProductionStaffRows<T extends { role: string | null }>(
  rows: readonly T[],
  mode: 'key' | 'all',
): T[] {
  if (mode === 'all') {
    return [...rows];
  }
  return rows.filter((r) => isKeyProductionRole(r.role));
}
