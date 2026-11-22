import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AnisongdbRankedError,
  anisongdbRankedStatus,
  searchAnisongdb,
  searchAnisongdbByAnime,
} from '../lib/importers/anilist/themeSongs/anisongdbApi';
import type { AnisongdbPreviewUrls } from '../lib/importers/anilist/themeSongs/anisongdbMatch';
import { resolveAnisongdbPreviewFromHits } from '../lib/importers/anilist/themeSongs/anisongdbMatch';
import {
  persistentCacheDelete,
  persistentCacheGet,
  persistentCacheSet,
} from '../lib/importers/anilist/toolsPersistentCache';
import { themeSongRowKey } from '../lib/importers/anilist/themeSongs/themeSongRowKey';
import type { MediaThemeSongRow } from '../lib/importers/anilist/themeSongs/types';
import { sessionMemoDelete, withSessionMemo } from '../lib/importers/anilist/toolsSessionMemo';

export const ANISONGDB_PREVIEW_CACHE_TTL_MS = 15 * 24 * 60 * 60 * 1000;

export type ThemeSongPreviewStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

export type ThemeSongPreviewParams = {
  mediaId: number;
  animeTitle: string;
  row: MediaThemeSongRow;
  songTitle: string;
  songArtist: string | null;
  enabled: boolean;
};

function cacheKeyForRow(mediaId: number, row: MediaThemeSongRow): string {
  return `anisongdb:preview:v1:${mediaId}:${themeSongRowKey(row)}`;
}

/** e.g. "AnisongDB song search is paused for AMQ Ranked (Central, about 4 min left)." */
export function rankedFailureDetail(now = new Date()): string {
  const ranked = anisongdbRankedStatus(now);
  if (!ranked.active) {
    return 'AnisongDB song search is paused for AMQ Ranked.';
  }
  const minutes = Math.max(1, Math.ceil(ranked.remainingSeconds / 60));
  return `AnisongDB song search is paused for AMQ Ranked (${ranked.region}, about ${minutes} min left).`;
}

export function themeSongPreviewFailureTooltip(
  status: ThemeSongPreviewStatus,
  failureDetail: string | null = null,
): string {
  if (status === 'error') {
    return `${failureDetail ?? 'Preview lookup failed.'} Click to retry.`;
  }
  if (status === 'unavailable') {
    return 'No matching AnisongDB preview for this song. Click to retry.';
  }
  return 'Preview on AnisongDB. Right-click to refresh lookup.';
}

export function useThemeSongPreview({
  mediaId,
  animeTitle,
  row,
  songTitle,
  songArtist,
  enabled,
}: ThemeSongPreviewParams) {
  const cacheKey = useMemo(
    () => cacheKeyForRow(mediaId, row),
    [mediaId, row],
  );

  const [status, setStatus] = useState<ThemeSongPreviewStatus>('idle');
  const [urls, setUrls] = useState<AnisongdbPreviewUrls | null>(null);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [cacheHydrated, setCacheHydrated] = useState(false);
  const [failureDetail, setFailureDetail] = useState<string | null>(null);

  const applyResolved = useCallback((value: AnisongdbPreviewUrls | null): ThemeSongPreviewStatus => {
    if (value === null) {
      setStatus('unavailable');
      setUrls(null);
      return 'unavailable';
    }
    setStatus('ready');
    setUrls(value);
    return 'ready';
  }, []);

  useEffect(() => {
    if (!enabled) {
      setCacheHydrated(true);
      return;
    }
    let cancelled = false;
    void persistentCacheGet<AnisongdbPreviewUrls | null>(cacheKey).then((cached) => {
      if (cancelled) {
        return;
      }
      if (cached.hit) {
        applyResolved(cached.value);
      }
      setCacheHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [applyResolved, cacheKey, enabled]);

  const fetchAndMatch = useCallback(
    async (options?: { bustCache?: boolean }): Promise<ThemeSongPreviewStatus> => {
      if (!enabled) {
        setStatus('unavailable');
        return 'unavailable';
      }

      if (options?.bustCache) {
        sessionMemoDelete(cacheKey);
        await persistentCacheDelete(cacheKey);
      } else {
        const cached = await persistentCacheGet<AnisongdbPreviewUrls | null>(cacheKey);
        if (cached.hit) {
          return applyResolved(cached.value);
        }
      }

      setStatus('loading');
      try {
        const value = await withSessionMemo(cacheKey, async () => {
            const input = { mediaId, animeTitle, row, songTitle, songArtist };
            let hits;
            try {
              hits = await searchAnisongdb(songTitle);
            } catch (error) {
              if (!(error instanceof AnisongdbRankedError)) throw error;
              // Anime search still works during Ranked; a miss there isn't cached as "unavailable".
              const resolved = resolveAnisongdbPreviewFromHits(
                await searchAnisongdbByAnime(animeTitle),
                input,
              );
              if (resolved === null) throw error;
              await persistentCacheSet(cacheKey, resolved, ANISONGDB_PREVIEW_CACHE_TTL_MS);
              return resolved;
            }
            const resolved = resolveAnisongdbPreviewFromHits(hits, input);
            await persistentCacheSet(cacheKey, resolved, ANISONGDB_PREVIEW_CACHE_TTL_MS);
            return resolved;
          },
        );
        setFailureDetail(null);
        return applyResolved(value);
      } catch (error) {
        setFailureDetail(error instanceof AnisongdbRankedError ? rankedFailureDetail() : null);
        setStatus('error');
        setUrls(null);
        return 'error';
      }
    },
    [
      animeTitle,
      applyResolved,
      cacheKey,
      enabled,
      mediaId,
      row,
      songArtist,
      songTitle,
    ],
  );

  const retryPreview = useCallback(async () => {
    if (!enabled) {
      return;
    }
    setPlayerOpen(false);
    const next = await fetchAndMatch({ bustCache: true });
    if (next === 'ready') {
      setPlayerOpen(true);
    }
  }, [enabled, fetchAndMatch]);

  const togglePreview = useCallback(async () => {
    if (!enabled || status === 'loading') {
      return;
    }
    if (status === 'unavailable' || status === 'error') {
      await retryPreview();
      return;
    }
    if (playerOpen) {
      setPlayerOpen(false);
      return;
    }
    setPlayerOpen(true);
    if (status === 'idle') {
      const next = await fetchAndMatch();
      if (next === 'unavailable' || next === 'error') {
        setPlayerOpen(false);
      }
    }
  }, [enabled, fetchAndMatch, playerOpen, retryPreview, status]);

  useEffect(() => {
    if (status === 'unavailable' || status === 'error') {
      setPlayerOpen(false);
    }
  }, [status]);

  return {
    status,
    urls,
    playerOpen,
    cacheHydrated,
    setPlayerOpen,
    togglePreview,
    retryPreview,
    failureTooltip: themeSongPreviewFailureTooltip(status, failureDetail),
  };
}
