import type { MediaRow } from './types';

/**
 * Sort key for AniList-style “release date” ordering (start date, then season year).
 * Higher values sort earlier when using {@link compareMediaByReleaseDateDesc}.
 */
export function mediaReleaseSortKey(media: MediaRow): number {
  const year = media.start_year ?? media.season_year ?? 0;
  const month = media.start_month ?? 0;
  const day = media.start_day ?? 0;
  return year * 10_000 + month * 100 + day;
}

/** Newest release first; ties broken by media id (stable). */
export function compareMediaByReleaseDateDesc(a: MediaRow, b: MediaRow): number {
  const dateDiff = mediaReleaseSortKey(b) - mediaReleaseSortKey(a);
  if (dateDiff !== 0) {
    return dateDiff;
  }
  return b.id - a.id;
}
