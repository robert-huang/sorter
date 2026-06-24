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
 */
export function alignRoleCellsAcrossShows(
  roleLists: ReadonlyArray<readonly string[]>,
): string[][] {
  const showCount = roleLists.length;
  if (showCount === 0) {
    return [];
  }

  const remaining = roleLists.map((roles) => [...roles]);
  const rows: string[][] = [];

  for (const role of roleLists[0] ?? []) {
    const cells = Array<string>(showCount).fill('');
    cells[0] = role;
    const anchorPool = remaining[0]!;
    anchorPool.splice(anchorPool.indexOf(role), 1);

    for (let showIdx = 1; showIdx < showCount; showIdx += 1) {
      const pool = remaining[showIdx]!;
      const matchIdx = pool.indexOf(role);
      if (matchIdx >= 0) {
        cells[showIdx] = role;
        pool.splice(matchIdx, 1);
      }
    }
    rows.push(cells);
  }

  for (let showIdx = 1; showIdx < showCount; showIdx += 1) {
    const pool = remaining[showIdx]!;
    while (pool.length > 0) {
      const role = pool.shift()!;
      const cells = Array<string>(showCount).fill('');
      cells[showIdx] = role;
      for (let otherIdx = 0; otherIdx < showCount; otherIdx += 1) {
        if (otherIdx === showIdx) {
          continue;
        }
        const otherPool = remaining[otherIdx]!;
        const matchIdx = otherPool.indexOf(role);
        if (matchIdx >= 0) {
          cells[otherIdx] = role;
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

/**
 * Align VA role labels across shows by character id. Cast role (MAIN vs SUPPORTING)
 * may differ; matching characters still share a row.
 */
export function alignVaRoleCellsAcrossShows(
  roleLists: ReadonlyArray<readonly VaRoleCell[]>,
): string[][] {
  const showCount = roleLists.length;
  if (showCount === 0) {
    return [];
  }

  const remaining = roleLists.map((roles) => [...roles]);
  const rows: string[][] = [];

  for (const anchor of roleLists[0] ?? []) {
    const cells = Array<string>(showCount).fill('');
    cells[0] = anchor.label;
    const anchorPool = remaining[0]!;
    const anchorIdx = anchorPool.findIndex((role) => role.characterId === anchor.characterId);
    if (anchorIdx >= 0) {
      anchorPool.splice(anchorIdx, 1);
    }

    for (let showIdx = 1; showIdx < showCount; showIdx += 1) {
      const pool = remaining[showIdx]!;
      const matchIdx = pool.findIndex((role) => role.characterId === anchor.characterId);
      if (matchIdx >= 0) {
        cells[showIdx] = pool[matchIdx]!.label;
        pool.splice(matchIdx, 1);
      }
    }
    rows.push(cells);
  }

  for (let showIdx = 1; showIdx < showCount; showIdx += 1) {
    const pool = remaining[showIdx]!;
    while (pool.length > 0) {
      const role = pool.shift()!;
      const cells = Array<string>(showCount).fill('');
      cells[showIdx] = role.label;
      rows.push(cells);
    }
  }

  return rows;
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
