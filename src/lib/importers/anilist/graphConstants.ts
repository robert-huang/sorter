/** Stale warning threshold for cast/staff/filmography timestamps. */
export const GRAPH_STALE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Cast-expansion rows backfilled from v1 use `fetched_at = 0` when the real
 * pull time was lost (see migration 002). The cache exists but the date is unknown.
 */
export function isUnknownGraphCacheDate(fetchedAt: number): boolean {
  return fetchedAt <= 0;
}

/** False for null or v1 backfill sentinel (`0`) — expansion should re-stamp these. */
export function hasKnownGraphCacheDate(fetchedAt: number | null): boolean {
  return fetchedAt !== null && !isUnknownGraphCacheDate(fetchedAt);
}

export function isGraphTimestampStale(fetchedAt: number | null, now = Date.now()): boolean {
  if (fetchedAt === null) {
    return false;
  }
  if (isUnknownGraphCacheDate(fetchedAt)) {
    return true;
  }
  return now - fetchedAt > GRAPH_STALE_MS;
}

/** `YYYY-MM-DD` in the user's local timezone — shown in stale-cache tooltips. */
export function formatGraphCacheDate(fetchedAt: number): string {
  if (isUnknownGraphCacheDate(fetchedAt)) {
    return 'unknown date';
  }
  const d = new Date(fetchedAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Among `timestamps`, return the oldest one that is currently stale.
 * Used when cast + staff caches can age independently but share one
 * refresh affordance.
 */
export function oldestStaleGraphTimestamp(
  timestamps: readonly (number | null)[],
  now = Date.now(),
): number | null {
  let oldestKnown: number | null = null;
  let oldestUnknown: number | null = null;
  for (const t of timestamps) {
    if (t === null || !isGraphTimestampStale(t, now)) {
      continue;
    }
    if (isUnknownGraphCacheDate(t)) {
      if (oldestUnknown === null) {
        oldestUnknown = t;
      }
      continue;
    }
    if (oldestKnown === null || t < oldestKnown) {
      oldestKnown = t;
    }
  }
  return oldestKnown ?? oldestUnknown;
}

/** Tooltip / aria-label copy for a stale graph-cache refresh button. */
export function graphStaleRefreshTooltip(
  fetchedAt: number,
  subject: string,
  verb: 'refresh' | 're-fetch' = 're-fetch',
): string {
  return `${subject} is over 90 days old (${formatGraphCacheDate(fetchedAt)}) — click to ${verb} from AniList`;
}
