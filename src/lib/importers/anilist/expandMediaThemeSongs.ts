/**
 * Lazy theme-song expansion: AniList idMal → Tenrai/MAL themes → AniPlaylist merge.
 */

import type { AnilistImportContext } from './context';
import {
  MEDIA_STUB_UPSERT_SQL,
  mediaStubRowToParams,
  type MediaStubRow,
} from './lazyExpansion';
import { emitProgress } from './progress';
import { MEDIA_THEME_SONGS_QUERY } from './queries';
import { needsGraphDataRefresh } from './toolsFetchPolicy';
import {
  findMatchingAnimeCluster,
  groupHitsByAnimeId,
  searchAniplaylistForRecordingAliases,
  searchAniplaylistForMediaTitles,
  AniplaylistSearchError,
  collectMediaTitleStrings,
  normalizeAniplaylistThemeType,
} from './themeSongs/aniplaylistApi';
import {
  enrichMalThemesWithOfficialIfNeeded,
  fetchMalThemeStrings,
  formatMalThemeFailureDetail,
} from './themeSongs/malThemeFetch';
import { parseMalThemes } from './themeSongs/malThemeParser';
import {
  applyAniplaylistRecordingAliases,
  borrowSharedSpotifyMetadata,
  mergeThemeSongs,
} from './themeSongs/mergeThemeSongs';
import { enrichRowsWithSpotifyIsrc } from './themeSongs/spotifyIsrc';
import {
  applyThemeSongExclusions,
  mergeExcludedRowKeys,
} from './themeSongs/themeSongExclusions';
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

type MediaThemeSongsResponse = {
  Media?: {
    id: number;
    idMal: number | null;
    type: MediaStubRow['type'];
    title: {
      english: string | null;
      romaji: string | null;
      native: string | null;
    };
    coverImage: { large: string | null } | null;
    format: MediaStubRow['format'];
    startDate: {
      year: number | null;
      month: number | null;
      day: number | null;
    } | null;
    synonyms: string[] | null;
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

function normalizeThemeSongsPayload(
  payload: MediaThemeSongsPayload,
): MediaThemeSongsPayload {
  return {
    ...payload,
    rows: borrowSharedSpotifyMetadata(payload.rows),
  };
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
    payload: normalizeThemeSongsPayload(payload),
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
        out.set(Number(row.media_id), normalizeThemeSongsPayload(payload));
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

async function persistMissingMediaStub(
  ctx: AnilistImportContext,
  media: NonNullable<MediaThemeSongsResponse['Media']>,
): Promise<void> {
  const now = ctx.now();
  const row: MediaStubRow = {
    id: media.id,
    type: media.type,
    title_english: media.title.english,
    title_romaji: media.title.romaji,
    title_native: media.title.native,
    cover_image: media.coverImage?.large ?? null,
    format: media.format,
    start_year: media.startDate?.year ?? null,
    start_month: media.startDate?.month ?? null,
    start_day: media.startDate?.day ?? null,
    synonyms_json: media.synonyms ? JSON.stringify(media.synonyms) : null,
    fetched_at: now,
    updated_at: now,
  };
  await ctx.db.execBatch([
    {
      sql: MEDIA_STUB_UPSERT_SQL,
      params: mediaStubRowToParams(row),
    },
  ]);
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
    await ctx.onDirtyIncrement({
      kind: 'media-theme-songs',
      mediaId,
      payload,
    });
  }
}

export async function expandMediaThemeSongs(
  ctx: AnilistImportContext,
  mediaId: number,
  options: ExpandMediaThemeSongsOptions = {},
): Promise<ExpandMediaThemeSongsResult | null> {
  const cachedMedia = await readMediaLite(ctx.db, mediaId);
  if (cachedMedia && cachedMedia.type !== 'ANIME') {
    return null;
  }

  const existingExpansion = await getMediaThemeSongsExpansion(ctx.db, mediaId);
  // Explicit ↻ refresh re-fetches from sources and drops manual × exclusions.
  const preservedExcludedRowKeys = options.force
    ? []
    : (existingExpansion?.payload.excludedRowKeys ?? []);

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

  const mediaResponse = await ctx.executeQuery<MediaThemeSongsResponse>(
    MEDIA_THEME_SONGS_QUERY,
    {
      id: mediaId,
    },
  );
  const fetchedMedia = mediaResponse?.Media ?? null;
  if (!fetchedMedia || fetchedMedia.type !== 'ANIME') {
    return null;
  }
  if (!cachedMedia) {
    await persistMissingMediaStub(ctx, fetchedMedia);
  }
  const malId = fetchedMedia.idMal;

  if (malId === null) {
    const sources: ThemeSongSourcesHealth = {
      jikan: okSource(),
      aniplaylist: okSource(),
    };
    const payload: MediaThemeSongsPayload = {
      version: 1,
      aniplaylistAvailable: true,
      sources,
      excludedRowKeys:
        preservedExcludedRowKeys.length > 0 ? [...preservedExcludedRowKeys] : undefined,
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

  let aniHits: Awaited<ReturnType<typeof searchAniplaylistForMediaTitles>> = [];
  let recordingAliasHits: Awaited<
    ReturnType<typeof searchAniplaylistForRecordingAliases>
  > = [];
  const mediaTitles = {
    english: fetchedMedia.title.english ?? cachedMedia?.title_english ?? null,
    romaji: fetchedMedia.title.romaji ?? cachedMedia?.title_romaji ?? null,
    native: fetchedMedia.title.native ?? cachedMedia?.title_native ?? null,
  };
  if (collectMediaTitleStrings(mediaTitles).length > 0) {
    try {
      const allHits = await searchAniplaylistForMediaTitles(mediaTitles);
      const clusters = groupHitsByAnimeId(allHits);
      const cluster = findMatchingAnimeCluster(
        clusters,
        malThemes.map((t) => ({ type: t.type, title: t.title, artist: t.artist })),
        mediaTitles,
      );
      if (cluster) {
        aniHits = cluster;
      }

      const enriched = await enrichMalThemesWithOfficialIfNeeded(themeResult, malId, {
        aniplaylistOpeningCount: aniHits.filter(
          (hit) =>
            normalizeAniplaylistThemeType(hit.song_type, hit.song_key) ===
            'Opening',
        ).length,
        aniplaylistEndingCount: aniHits.filter(
          (hit) =>
            normalizeAniplaylistThemeType(hit.song_type, hit.song_key) ===
            'Ending',
        ).length,
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
      recordingAliasHits = await searchAniplaylistForRecordingAliases(
        malThemes,
        aniHits,
      );
    } catch (err) {
      // A throttled response is transient. The request helper has already waited
      // and retried; if those retries are exhausted, preserve the previous cache.
      if (err instanceof AniplaylistSearchError && err.httpStatus === 429) {
        throw err;
      }
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
  rows = applyAniplaylistRecordingAliases(rows, recordingAliasHits);
  rows = await enrichRowsWithSpotifyIsrc(rows);
  rows = borrowSharedSpotifyMetadata(rows);
  rows = applyThemeSongExclusions(rows, preservedExcludedRowKeys);

  const aniplaylistAvailable = deriveLegacyAniplaylistAvailable(sources);
  const payload: MediaThemeSongsPayload = {
    version: 1,
    aniplaylistAvailable,
    sources,
    excludedRowKeys:
      preservedExcludedRowKeys.length > 0 ? [...preservedExcludedRowKeys] : undefined,
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

/** Remove one theme row from a media entry; persists across re-fetch. */
export async function excludeMediaThemeSongRow(
  ctx: AnilistImportContext,
  mediaId: number,
  rowKey: string,
): Promise<MediaThemeSongsPayload | null> {
  const existing = await getMediaThemeSongsExpansion(ctx.db, mediaId);
  if (!existing) {
    return null;
  }

  const excludedRowKeys = mergeExcludedRowKeys(existing.payload.excludedRowKeys, rowKey);
  const rows = applyThemeSongExclusions(existing.payload.rows, excludedRowKeys);
  const payload: MediaThemeSongsPayload = {
    ...existing.payload,
    excludedRowKeys,
    rows,
  };
  await persistThemeSongsExpansion(ctx, mediaId, existing.malId, payload);
  return payload;
}
