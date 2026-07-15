/**
 * Set helpers ported from anilisttools `request_utils.py` — used by Shared
 * Credits and Shared Staff when computing intersections and per-staff diffs.
 */

/** Keys appearing in at least `n` dicts (default: all), order from first dict. */
export function dictIntersection<T>(
  dicts: ReadonlyArray<Readonly<Record<string, T>>>,
  n?: number,
): string[] {
  if (dicts.length === 0) {
    return [];
  }

  const threshold = n ?? dicts.length;
  const seen = new Set<string>();
  const out: string[] = [];

  for (const subdict of dicts) {
    for (const key of Object.keys(subdict)) {
      if (seen.has(key)) {
        continue;
      }
      const count = dicts.reduce((acc, d) => acc + (key in d ? 1 : 0), 0);
      if (count >= threshold) {
        seen.add(key);
        out.push(key);
      }
    }
  }

  return out;
}

/**
 * Align role labels across shows so matching roles share a row. Walks the first
 * show's role list in order; each role is paired with the same label in other
 * shows when present. Unmatched roles from other shows follow in their native
 * order.
 *
 * An optional `normalize` hook lets callers collapse cosmetically-different
 * labels that should still share a row — e.g. production-staff roles where
 * AniList tacks on episode / segment scope as a parenthetical (`Animation
 * Director (OP1, OP3)` vs `Animation Director (eps 1-4)`). The match is
 * exact-label-first and only falls back to the normalized key, so identical
 * labels still align to their identical counterparts before fuzzy matches
 * pull them off — that preserves the previous identity-preferring layout when
 * exact matches exist on both sides. Displayed cells always carry the
 * ORIGINAL label so the parenthetical detail survives the merge.
 *
 * Default normalize is the identity, which preserves the original
 * exact-string-only behaviour for callers (studios, etc.) that don't want
 * the fuzzy match.
 */
export function alignRoleCellsAcrossShows(
  roleLists: ReadonlyArray<readonly string[]>,
  normalize: (label: string) => string = (label) => label,
): string[][] {
  const showCount = roleLists.length;
  if (showCount === 0) {
    return [];
  }

  // Parallel `{ label, key }` per pool so we don't re-normalize on every
  // findIndex. Splices remove entries from both fields at once.
  type PoolEntry = { label: string; key: string };
  const remaining: PoolEntry[][] = roleLists.map((roles) =>
    roles.map((label) => ({ label, key: normalize(label) })),
  );

  /** Prefer an exact label match (so identical labels stay paired together);
   *  fall back to matching on the normalized key when no exact match exists. */
  function findMatchIdx(pool: PoolEntry[], label: string, key: string): number {
    const exact = pool.findIndex((entry) => entry.label === label);
    if (exact >= 0) return exact;
    return pool.findIndex((entry) => entry.key === key);
  }

  const rows: string[][] = [];

  // Phase 1: anchor on show 0. Each anchor role pulls its own match (or
  // a normalized-key match) out of every other show's pool.
  const anchorRoles = roleLists[0] ?? [];
  for (const anchorLabel of anchorRoles) {
    const cells = Array<string>(showCount).fill('');
    cells[0] = anchorLabel;
    const anchorKey = normalize(anchorLabel);

    const anchorPool = remaining[0]!;
    const anchorPoolIdx = findMatchIdx(anchorPool, anchorLabel, anchorKey);
    if (anchorPoolIdx >= 0) {
      anchorPool.splice(anchorPoolIdx, 1);
    }

    for (let showIdx = 1; showIdx < showCount; showIdx += 1) {
      const pool = remaining[showIdx]!;
      const matchIdx = findMatchIdx(pool, anchorLabel, anchorKey);
      if (matchIdx >= 0) {
        cells[showIdx] = pool[matchIdx]!.label;
        pool.splice(matchIdx, 1);
      }
    }
    rows.push(cells);
  }

  // Phase 2: leftover roles only present on non-anchor shows. Same
  // exact-first / key-fallback rule lets a role that's only on shows 2+
  // still cluster on one row even if the labels differ in detail.
  for (let showIdx = 1; showIdx < showCount; showIdx += 1) {
    const pool = remaining[showIdx]!;
    while (pool.length > 0) {
      const seed = pool.shift()!;
      const cells = Array<string>(showCount).fill('');
      cells[showIdx] = seed.label;
      for (let otherIdx = 0; otherIdx < showCount; otherIdx += 1) {
        if (otherIdx === showIdx) {
          continue;
        }
        const otherPool = remaining[otherIdx]!;
        const matchIdx = findMatchIdx(otherPool, seed.label, seed.key);
        if (matchIdx >= 0) {
          cells[otherIdx] = otherPool[matchIdx]!.label;
          otherPool.splice(matchIdx, 1);
        }
      }
      rows.push(cells);
    }
  }

  return rows;
}

export type VaRoleCell = {
  characterId: number;
  label: string;
};

export type VaRoleAlignedCell = {
  characterId: number | null;
  label: string;
};

const EMPTY_VA_ROLE_CELL: VaRoleAlignedCell = { characterId: null, label: '' };

function emptyVaRoleCells(showCount: number): VaRoleAlignedCell[] {
  return Array.from({ length: showCount }, () => ({ ...EMPTY_VA_ROLE_CELL }));
}

/**
 * Align VA role labels across shows by character id. Cast role (MAIN vs BACKGROUND)
 * may differ; matching characters still share a row. Leftover roles on non-anchor
 * shows are cross-matched so a character only in shows 2+ still aligns.
 */
function alignVaRoleCellsAcrossShowsInternal(
  roleLists: ReadonlyArray<readonly VaRoleCell[]>,
): VaRoleAlignedCell[][] {
  const showCount = roleLists.length;
  if (showCount === 0) {
    return [];
  }

  const remaining = roleLists.map((roles) => [...roles]);
  const rows: VaRoleAlignedCell[][] = [];

  for (const anchor of roleLists[0] ?? []) {
    const cells = emptyVaRoleCells(showCount);
    cells[0] = { characterId: anchor.characterId, label: anchor.label };
    const anchorPool = remaining[0]!;
    const anchorIdx = anchorPool.findIndex((role) => role.characterId === anchor.characterId);
    if (anchorIdx >= 0) {
      anchorPool.splice(anchorIdx, 1);
    }

    for (let showIdx = 1; showIdx < showCount; showIdx += 1) {
      const pool = remaining[showIdx]!;
      const matchIdx = pool.findIndex((role) => role.characterId === anchor.characterId);
      if (matchIdx >= 0) {
        const match = pool[matchIdx]!;
        cells[showIdx] = { characterId: match.characterId, label: match.label };
        pool.splice(matchIdx, 1);
      }
    }
    rows.push(cells);
  }

  for (let showIdx = 1; showIdx < showCount; showIdx += 1) {
    const pool = remaining[showIdx]!;
    while (pool.length > 0) {
      const role = pool.shift()!;
      const cells = emptyVaRoleCells(showCount);
      cells[showIdx] = { characterId: role.characterId, label: role.label };
      for (let otherIdx = 0; otherIdx < showCount; otherIdx += 1) {
        if (otherIdx === showIdx) {
          continue;
        }
        const otherPool = remaining[otherIdx]!;
        const matchIdx = otherPool.findIndex((other) => other.characterId === role.characterId);
        if (matchIdx >= 0) {
          const match = otherPool[matchIdx]!;
          cells[otherIdx] = { characterId: match.characterId, label: match.label };
          otherPool.splice(matchIdx, 1);
        }
      }
      rows.push(cells);
    }
  }

  return rows;
}

export function alignVaRoleCellsAcrossShows(
  roleLists: ReadonlyArray<readonly VaRoleCell[]>,
): string[][] {
  return alignVaRoleCellsAcrossShowsInternal(roleLists).map((row) =>
    row.map((cell) => cell.label),
  );
}

/** Like {@link alignVaRoleCellsAcrossShows} but keeps per-cell character ids for AniList links. */
export function alignVaRoleCellsAcrossShowsWithIds(
  roleLists: ReadonlyArray<readonly VaRoleCell[]>,
): VaRoleAlignedCell[][] {
  return alignVaRoleCellsAcrossShowsInternal(roleLists);
}

/** Per-dict keys unique to that dict, preserving each dict's key order. */
export function dictDiffs<T>(
  dicts: ReadonlyArray<Readonly<Record<string, T>>>,
): string[][] {
  return dicts.map((curDict) => {
    const otherKeys = new Set<string>();
    for (const d of dicts) {
      if (d !== curDict) {
        for (const key of Object.keys(d)) {
          otherKeys.add(key);
        }
      }
    }
    return Object.keys(curDict).filter((key) => !otherKeys.has(key));
  });
}
