import { normalizeProductionRoleForMatch } from './staffRoleFilter';

/**
 * Manual display/sort priority for production staff in anime-to-anime hops.
 * Lower index = more senior. Matching uses the same normalization as
 * {@link normalizeProductionRoleForMatch} (parentheticals, chief/assistant).
 */
export const PRODUCTION_ROLE_PRIORITY: readonly string[] = [
  'original creator',
  'original character design',
  'director',
  'series director',
  'series composition',
  'script',
  'character design',
  'animation director',
  'theme song performance',
  'insert song performance',
  'music',
  'sound director',
  'episode director',
  'sub character design',
  'art director',
  'color design',
  'theme song composition',
  'theme song lyrics',
  'insert song composition',
  'insert song lyrics',
];

const PRIORITY_INDEX = new Map(
  PRODUCTION_ROLE_PRIORITY.map((role, index) => [role, index]),
);

/** Sort key for one raw AniList role string; unknown roles sort last. */
export function productionRolePriorityIndex(role: string): number {
  const norm = normalizeProductionRoleForMatch(role);
  return PRIORITY_INDEX.get(norm) ?? Number.POSITIVE_INFINITY;
}

/** Best (lowest) priority index across all of a staff member's roles. */
export function bestProductionRolePriorityIndex(roles: readonly string[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const role of roles) {
    best = Math.min(best, productionRolePriorityIndex(role));
  }
  return best;
}

/** Order role labels for display — highest-priority role first. */
export function sortProductionRolesByPriority(roles: readonly string[]): string[] {
  return [...roles].sort((a, b) => {
    const diff = productionRolePriorityIndex(a) - productionRolePriorityIndex(b);
    if (diff !== 0) {
      return diff;
    }
    return a.localeCompare(b, undefined, { sensitivity: 'accent' });
  });
}

export function compareProductionStaffByRolePriority(
  a: { roles: readonly string[]; minSortOrder: number; staffId: number },
  b: { roles: readonly string[]; minSortOrder: number; staffId: number },
): number {
  const priorityDiff =
    bestProductionRolePriorityIndex(a.roles) - bestProductionRolePriorityIndex(b.roles);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  if (a.minSortOrder !== b.minSortOrder) {
    return a.minSortOrder - b.minSortOrder;
  }
  return a.staffId - b.staffId;
}
