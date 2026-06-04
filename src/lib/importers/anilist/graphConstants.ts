/** Stale warning threshold for cast/staff/filmography timestamps. */
export const GRAPH_STALE_MS = 90 * 24 * 60 * 60 * 1000;

export function isGraphTimestampStale(fetchedAt: number | null, now = Date.now()): boolean {
  if (fetchedAt === null) {
    return false;
  }
  return now - fetchedAt > GRAPH_STALE_MS;
}
