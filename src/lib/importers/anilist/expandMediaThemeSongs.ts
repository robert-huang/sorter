/**
 * Lazy theme-song expansion: AniList idMal → Jikan/MAL themes → AniPlaylist merge.
 */

import type { AnilistImportContext } from './context';
import { emitProgress } from './progress';
import { MEDIA_ID_MAL_QUERY } from './queries';
import { needsGraphDataRefresh } from './toolsFetchPolicy';
import {
  findMatchingAnimeCluster,
  groupHitsByAnimeId,
  searchAniplaylist,
  AniplaylistSearchError,
} from './themeSongs/aniplaylistApi';
import {
  enrichMalThemesWithOfficialIfNeeded,
  fetchMalThemeStrings,
  formatMalThemeFailureDetail,
} from './themeSongs/malThemeFetch';
import { parseMalThemes } from './themeSongs/malThemeParser';
import { mergeThemeSongs } from './themeSongs/mergeThemeSongs';
import { enrichRowsWithSpotifyIsrc } from './themeSongs/spotifyIsrc';
import {
  deriveLegacyAniplaylistAvailable,
  failedSource,
  okSource,
  type ThemeSongSourcesHealth,
} from './themeSongs/themeSongSources';
import type {
  MediaThemeSongsExpansion,
  MediaThemeSongsPayload,
} from './themeSongs/types';
import type { AnilistDbExecutor } from './context';

type MediaIdMalResponse = {
  Media?: {
    id: number;
    idMal: number | null;
  } | null;
};

type MediaRowLite = {
  type: string;
  title_english: string | null;
  title_romaji: string | null;
  title_native: string | null;
};

export type ExpandMediaThemeSongsResult = {
  mediaId: number;
  malId: number | null;
  rowsWritten: number;
  aniplaylistAvailable: boolean;
};

export type ExpandMediaThemeSongsOptions = {
  force?: boolean;
};

function pickSearchTitle(media: MediaRowLite): string {
  return (
    media.title_english?.trim() ||
    media.title_romaji?.trim() ||
    media.title_native?.trim() ||
    ''
  );
}

export async function getMediaThemeSongsExpansionFetchedAt(
  db: AnilistDbExecutor,
  mediaId: number,
): Promise<number | null> {
  const rows = await db.exec(
    'SELECT fetched_at FROM media_theme_songs_expansion WHERE media_id = ?',
    [mediaId],
  );
  if (rows.length === 0) {
    return null;
  }
  const v = rows[0].fetched_at;
  return v === null || v === undefined ? null : Number(v);
}

export async function getMediaThemeSongsExpansion(
  db: AnilistDbExecutor,
  mediaId: number,
): Promise<MediaThemeSongsExpansion | null> {
  const rows = await db.exec(
    `SELECT media_id, mal_id, fetched_at, payload_json
       FROM media_theme_songs_expansion WHERE media_id = ?`,
    [mediaId],
  );
  if (rows.length === 0) {
    return null;
  }
  const r = rows[0];
  let payload: MediaThemeSongsPayload;
  try {
    payload = JSON.parse(String(r.payload_json)) as MediaThemeSongsPayload;
  } catch {
    return null;
  }
  return {
    mediaId: Number(r.media_id),
    malId: r.mal_id === null || r.mal_id === undefined ? null : Number(r.mal_id),
    fetchedAt: Number(r.fetched_at),
    payload,
  };
}

const THEME_SONGS_BATCH_CHUNK_SIZE = 400;

/** Read cached theme-song payloads for many media ids (DB only, no fetch). */
export async function getMediaThemeSongsExpansionsBatch(
  db: AnilistDbExecutor,
  mediaIds: readonly number[],
): Promise<Map<number, MediaThemeSongsPayload>> {
  const out = new Map<number, MediaThemeSongsPayload>();
  const unique = [...new Set(mediaIds)].filter((id) => id > 0);
  for (let i = 0; i < unique.length; i += THEME_SONGS_BATCH_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + THEME_SONGS_BATCH_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db.exec(
      `SELECT media_id, payload_json
         FROM media_theme_songs_expansion
        WHERE media_id IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      try {
        const payload = JSON.parse(String(row.payload_json)) as MediaThemeSongsPayload;
        out.set(Number(row.media_id), payload);
      } catch {
        /* skip corrupt rows */
      }
    }
  }
  return out;
}

async function readMediaLite(
  db: AnilistDbExecutor,
  mediaId: number,
): Promise<MediaRowLite | null> {
  const rows = await db.exec(
    `SELECT type, title_english, title_romaji, title_native
       FROM media WHERE id = ?`,
    [mediaId],
  );
  if (rows.length === 0) {
    return null;
  }
  const r = rows[0];
  return {
    type: String(r.type),
    title_english: r.title_english === null ? null : String(r.title_english),
    title_romaji: r.title_romaji === null ? null : String(r.title_romaji),
    title_native: r.title_native === null ? null : String(r.title_native),
  };
}

async function persistThemeSongsExpansion(
  ctx: AnilistImportContext,
  mediaId: number,
  malId: number | null,
  payload: MediaThemeSongsPayload,
): Promise<void> {
  const now = ctx.now();
  await ctx.db.execBatch([
    {
      sql: `INSERT INTO media_theme_songs_expansion (media_id, mal_id, fetched_at, payload_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
              mal_id = excluded.mal_id,
              fetched_at = excluded.fetched_at,
              payload_json = excluded.payload_json`,
      params: [mediaId, malId, now, JSON.stringify(payload)],
    },
  ]);
  if (ctx.onDirtyIncrement) {
    await ctx.onDirtyIncrement();
  }
}

export async function expandMediaThemeSongs(
  ctx: AnilistImportContext,
  mediaId: number,
  options: ExpandMediaThemeSongsOptions = {},
): Promise<ExpandMediaThemeSongsResult | null> {
  const media = await readMediaLite(ctx.db, mediaId);
  if (!media) {
    return null;
  }
  if (media.type !== 'ANIME') {
    return null;
  }

  const fetchedAt = await getMediaThemeSongsExpansionFetchedAt(ctx.db, mediaId);
  if (!needsGraphDataRefresh(fetchedAt, { forceRefresh: options.force })) {
    const existing = await getMediaThemeSongsExpansion(ctx.db, mediaId);
    return {
      mediaId,
      malId: existing?.malId ?? null,
      rowsWritten: existing?.payload.rows.length ?? 0,
      aniplaylistAvailable: existing?.payload.aniplaylistAvailable ?? true,
    };
  }

  emitProgress(ctx.onProgress, {
    kind: 'fetching-page',
    what: 'theme-songs',
    page: 1,
    itemsSoFar: 0,
  });

  const malResponse = await ctx.executeQuery<MediaIdMalResponse>(MEDIA_ID_MAL_QUERY, {
    id: mediaId,
  });
  const malId = malResponse?.Media?.idMal ?? null;

  if (malId === null) {
    const sources: ThemeSongSourcesHealth = {
      jikan: okSource(),
      aniplaylist: okSource(),
    };
    const payload: MediaThemeSongsPayload = {
      version: 1,
      aniplaylistAvailable: true,
      sources,
      rows: [],
    };
    await persistThemeSongsExpansion(ctx, mediaId, null, payload);
    return { mediaId, malId: null, rowsWritten: 0, aniplaylistAvailable: true };
  }

  let themeResult = await fetchMalThemeStrings(malId);
  let malThemes = parseMalThemes(
    themeResult.data?.openings ?? [],
    themeResult.data?.endings ?? [],
  );

  const sources: ThemeSongSourcesHealth = {
    jikan:
      themeResult.status === 'failed'
        ? failedSource(formatMalThemeFailureDetail(themeResult))
        : okSource(),
    aniplaylist: okSource(),
  };

  let aniHits: Awaited<ReturnType<typeof searchAniplaylist>> = [];
  const searchTitle = pickSearchTitle(media);
  if (searchTitle) {
    try {
      const allHits = await searchAniplaylist(searchTitle);
      const clusters = groupHitsByAnimeId(allHits);
      const cluster = findMatchingAnimeCluster(
        clusters,
        malThemes.map((t) => ({ type: t.type, title: t.title, artist: t.artist })),
        {
          english: media.title_english,
          romaji: media.title_romaji,
          native: media.title_native,
        },
      );
      if (cluster) {
        const animeId = cluster[0]?.anime_id;
        aniHits = allHits.filter(
          (h) => h.anime_id === animeId && ['Opening', 'Ending', 'Insert'].includes(h.song_type),
        );
      }

      const enriched = await enrichMalThemesWithOfficialIfNeeded(themeResult, malId, {
        aniplaylistThemeCount: aniHits.length,
        aniplaylistEndingCount: aniHits.filter((h) => h.song_type === 'Ending').length,
      });
      if (enriched !== themeResult) {
        themeResult = enriched;
        if (themeResult.status !== 'failed') {
          sources.jikan = okSource();
        }
        malThemes = parseMalThemes(
          themeResult.data?.openings ?? [],
          themeResult.data?.endings ?? [],
        );
      }
    } catch (err) {
      const detail =
        err instanceof AniplaylistSearchError
          ? err.httpStatus === 403
            ? '403 (referer blocked — needs proxy)'
            : String(err.httpStatus)
          : err instanceof Error
            ? err.message
            : 'error';
      sources.aniplaylist = failedSource(detail);
    }
  }

  let rows = mergeThemeSongs(malThemes, aniHits);
  rows = await enrichRowsWithSpotifyIsrc(rows);

  const aniplaylistAvailable = deriveLegacyAniplaylistAvailable(sources);
  const payload: MediaThemeSongsPayload = {
    version: 1,
    aniplaylistAvailable,
    sources,
    rows,
  };
  await persistThemeSongsExpansion(ctx, mediaId, malId, payload);

  emitProgress(ctx.onProgress, { kind: 'done' });

  return {
    mediaId,
    malId,
    rowsWritten: rows.length,
    aniplaylistAvailable,
  };
}
