/**
 * Read-time filter for production staff roles. AniList returns free-form
 * role strings on StaffEdge — there is no server-side filter on Media.staff.
 *
 * Key roles match exactly against {@link KEY_ANIME_PRODUCTION_ROLES} or
 * {@link KEY_MANGA_PRODUCTION_ROLES} (media-type-specific) after:
 *   1. Trimming trailing parentheticals, e.g. `(ep 1)`, `(ED)`
 *   2. Lowercasing
 *   3. Stripping leading `Chief ` / `Assistant ` prefixes (repeat until none)
 */

import type { AnilistMediaType } from './types';

const KEY_ANIME_PRODUCTION_ROLES = new Set([
  'director',
  'series director',
  'animation director',
  'episode director',
  'sound director',
  'art director',
  'character design',
  'original character design',
  'sub character design',
  'color design',
  'original creator',
  'original story',
  'script',
  'series composition',
  'music',
  'music performance',
  'music composition',
  'music lyrics',
  'theme song performance',
  'theme song lyrics',
  'theme song composition',
  'insert song performance',
  'insert song lyrics',
  'insert song composition',
]);

/** Manga production credits on AniList use a much smaller role vocabulary. */
const KEY_MANGA_PRODUCTION_ROLES = new Set([
  'story',
  'art',
  'story & art',
  'illustration',
]);

/** Strip a trailing AniList episode/format suffix, e.g. `(ep 1)` or `(ED)`. */
function stripTrailingParenthetical(role: string): string {
  return role.replace(/\s*\([^)]*\)\s*$/i, '').trim();
}

const LEADING_ROLE_PREFIXES = ['chief ', 'assistant '] as const;

/** Strip stacked leading title prefixes, e.g. Chief Assistant Director. */
function stripLeadingRolePrefixes(normalized: string): string {
  let result = normalized;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of LEADING_ROLE_PREFIXES) {
      if (result.startsWith(prefix)) {
        result = result.slice(prefix.length);
        changed = true;
      }
    }
  }
  return result;
}

/** Normalize a raw AniList role string for exact key-role lookup. */
export function normalizeProductionRoleForMatch(role: string): string {
  const withoutSuffix = stripTrailingParenthetical(role.trim());
  return stripLeadingRolePrefixes(withoutSuffix.toLowerCase());
}

/**
 * Normalize for shared-staff row alignment: strip parenthetical scope only.
 * Chief / Executive / Assistant prefixes stay distinct so e.g. Chief Animation
 * Director does not collapse onto Animation Director.
 */
export function normalizeProductionRoleForCompare(role: string): string {
  if (!role) {
    return '';
  }
  return stripTrailingParenthetical(role.trim())
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Executive (0) → Chief (1) → base (2) → Assistant (3). */
export function productionRoleRankIndex(role: string): number {
  const normalized = stripTrailingParenthetical(role.trim()).toLowerCase();
  if (normalized.startsWith('executive ')) {
    return 0;
  }
  if (normalized.startsWith('chief ')) {
    return 1;
  }
  if (normalized.startsWith('assistant ')) {
    return 3;
  }
  return 2;
}

function representativeProductionRoleLabel(cells: readonly string[]): string {
  return cells.find((cell) => cell.length > 0) ?? '';
}

/**
 * Within a staff member's aligned compare rows, order rank variants of the
 * same base role Executive → Chief → base → Assistant while preserving
 * relative order across unrelated roles.
 */
export function sortProductionRoleRowsByRank(
  rows: ReadonlyArray<readonly string[]>,
): string[][] {
  const withMeta = rows.map((cells, originalIdx) => {
    const label = representativeProductionRoleLabel(cells);
    return {
      cells: [...cells],
      originalIdx,
      baseKey: normalizeProductionRoleForMatch(label),
      rank: productionRoleRankIndex(label),
    };
  });
  withMeta.sort((a, b) => {
    if (a.baseKey !== b.baseKey) {
      return a.originalIdx - b.originalIdx;
    }
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    return a.originalIdx - b.originalIdx;
  });
  return withMeta.map((entry) => entry.cells);
}

/**
 * Whether a production credit role counts as a "key" production role for
 * sorter detail panel and anime-to-anime production hops (default).
 */
export function isKeyProductionRole(
  role: string | null | undefined,
  mediaType: AnilistMediaType = 'ANIME',
): boolean {
  if (!role) {
    return false;
  }
  const normalized = normalizeProductionRoleForMatch(role);
  const bucket =
    mediaType === 'MANGA' ? KEY_MANGA_PRODUCTION_ROLES : KEY_ANIME_PRODUCTION_ROLES;
  return bucket.has(normalized);
}

export function filterProductionStaffRows<T extends { role: string | null }>(
  rows: readonly T[],
  mode: 'key' | 'all',
  mediaType: AnilistMediaType = 'ANIME',
): T[] {
  if (mode === 'all') {
    return [...rows];
  }
  return rows.filter((r) => isKeyProductionRole(r.role, mediaType));
}
