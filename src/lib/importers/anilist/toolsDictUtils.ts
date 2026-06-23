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
