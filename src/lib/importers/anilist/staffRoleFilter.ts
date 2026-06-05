/**
 * Read-time filter for production staff roles. AniList returns free-form
 * role strings on StaffEdge — there is no server-side filter on Media.staff.
 *
 * Key roles match exactly against {@link KEY_PRODUCTION_ROLES} after:
 *   1. Trimming trailing parentheticals, e.g. `(ep 1)`, `(ED)`
 *   2. Lowercasing
 *   3. Stripping leading `Chief ` / `Assistant ` prefixes (repeat until none)
 */

const KEY_PRODUCTION_ROLES = new Set([
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
  'script',
  'series composition',
  'music',
  'theme song performance',
  'theme song lyrics',
  'theme song composition',
  'insert song performance',
  'insert song lyrics',
  'insert song composition',
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
 * Whether a production credit role counts as a "key" production role for
 * sorter detail panel and anime-to-anime production hops (default).
 */
export function isKeyProductionRole(role: string | null | undefined): boolean {
  if (!role) {
    return false;
  }
  return KEY_PRODUCTION_ROLES.has(normalizeProductionRoleForMatch(role));
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
