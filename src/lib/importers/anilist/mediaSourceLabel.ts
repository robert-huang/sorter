import type { AnilistMediaSource } from './types';

/** Human-readable AniList `Media.source` label (matches seasonal filter chips). */
export function anilistMediaSourceLabel(source: AnilistMediaSource): string {
  switch (source) {
    case 'ORIGINAL':
      return 'Original';
    case 'MANGA':
      return 'Manga';
    case 'LIGHT_NOVEL':
      return 'Light Novel';
    case 'VISUAL_NOVEL':
      return 'Visual Novel';
    case 'NOVEL':
      return 'Novel';
    case 'VIDEO_GAME':
      return 'Video Game';
    case 'OTHER':
      return 'Other';
    case 'DOUJINSHI':
      return 'Doujinshi';
    case 'ANIME':
      return 'Anime';
    case 'WEB_NOVEL':
      return 'Web Novel';
    case 'LIVE_ACTION':
      return 'Live Action';
    case 'GAME':
      return 'Game';
    case 'COMIC':
      return 'Comic';
    case 'MULTIMEDIA_PROJECT':
      return 'Multimedia';
    case 'PICTURE_BOOK':
      return 'Picture Book';
  }
}

/** Label for the media modal. */
export function formatMediaSourceForDisplay(
  source: AnilistMediaSource | null | undefined,
  options?: { sourceFetchedAt?: number | null },
): string {
  if (options?.sourceFetchedAt == null) {
    return 'Not imported';
  }
  if (source == null) {
    return 'Unknown';
  }
  return anilistMediaSourceLabel(source);
}
