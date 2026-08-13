/**
 * Paginated `Staff.characters` + `Staff.staffMedia` fetch. Persists
 * adjacency into `media`, `media_staff`, `media_character`, CVA, etc.
 * `staff_filmography_expansion` is only a visit marker.
 */

import {
  type AnilistImportContext,
  execBatchInChunks,
  type SqlBindable,
} from './context';
import {
  mapStaffCharacterAppearanceData,
  mapStaffFilmographyMediaStaffRows,
} from './mappers';
import { persistMediaGraphCheckpoint } from './importer';
import {
  CHARACTER_STUB_UPSERT_SQL,
  characterStubRowToParams,
  DEFAULT_VOICE_ACTOR_LANGUAGE,
  MEDIA_STUB_UPSERT_SQL,
  mediaStubRowToParams,
  STAFF_UPSERT_SQL,
  staffRowToParams,
} from './lazyExpansion';
import { mapStaffRow } from './mappers';
import { emitProgress } from './progress';
import { buildStaffFilmographyQuery } from './queries';
import type {
  AnilistStaffCharacterMediaEdgeGql,
  AnilistStaffFilmographyResponse,
  AnilistStaffGql,
  AnilistStaffLanguage,
  AnilistStaffMediaEdgeGql,
} from './types';

export const DEFAULT_FILMOGRAPHY_PER_PAGE = 25;

export type ExpandStaffFilmographyOptions = {
  perPage?: number;
  charactersMaxPages?: number;
  staffMediaMaxPages?: number;
  voiceActorLanguage?: AnilistStaffLanguage;
  signal?: AbortSignal;
};

export type ExpandStaffFilmographyResult = {
  staffId: number;
  characterPagesFetched: number;
  staffMediaPagesFetched: number;
  mediaUpserted: number;
  mediaStaffWritten: number;
  cvaWritten: number;
};

async function fetchFilmographyPages(
  ctx: AnilistImportContext,
  staffId: number,
  perPage: number,
  charactersMaxPages: number | undefined,
  staffMediaMaxPages: number | undefined,
  signal?: AbortSignal,
): Promise<{
  characterEdges: AnilistStaffCharacterMediaEdgeGql[];
  staffMediaEdges: AnilistStaffMediaEdgeGql[];
  characterPagesFetched: number;
  staffMediaPagesFetched: number;
  staff: AnilistStaffGql | null;
  staffExists: boolean | null;
}> {
  const query = buildStaffFilmographyQuery();
  const characterEdges: AnilistStaffCharacterMediaEdgeGql[] = [];
  const staffMediaEdges: AnilistStaffMediaEdgeGql[] = [];
  let charactersPage = 1;
  let staffMediaPage = 1;
  let characterPagesFetched = 0;
  let staffMediaPagesFetched = 0;
  let charactersDone = charactersMaxPages === 0;
  let staffMediaDone = staffMediaMaxPages === 0;
  let staff: AnilistStaffGql | null = null;
  let staffExists: boolean | null = null;

  while (!charactersDone || !staffMediaDone) {
    signal?.throwIfAborted();
    const response = await ctx.executeQuery<AnilistStaffFilmographyResponse>(query, {
      id: staffId,
      charactersPage,
      staffMediaPage,
      perPage,
      includeCharacters: !charactersDone,
      includeStaffMedia: !staffMediaDone,
    });
    if (!response?.Staff) {
      if (staff === null) {
        staffExists = false;
      }
      break;
    }
    staffExists = true;
    if (staff === null) {
      staff = response.Staff;
    }

    if (!charactersDone) {
      characterPagesFetched += 1;
      const conn = response.Staff.characterMedia;
      if (conn) {
        characterEdges.push(...conn.edges);
      }
      emitProgress(ctx.onProgress, {
        kind: 'fetching-page',
        what: 'characters',
        page: charactersPage,
        itemsSoFar: characterEdges.length,
      });
      const hitMaxPages =
        charactersMaxPages !== undefined &&
        characterPagesFetched >= charactersMaxPages;
      charactersDone = !conn?.pageInfo.hasNextPage || hitMaxPages;
      if (!charactersDone) {
        charactersPage += 1;
      }
    }

    if (!staffMediaDone) {
      staffMediaPagesFetched += 1;
      const conn = response.Staff.staffMedia;
      if (conn) {
        staffMediaEdges.push(...conn.edges);
      }
      emitProgress(ctx.onProgress, {
        kind: 'fetching-page',
        what: 'staff',
        page: staffMediaPage,
        itemsSoFar: staffMediaEdges.length,
      });
      const hitMaxPages =
        staffMediaMaxPages !== undefined &&
        staffMediaPagesFetched >= staffMediaMaxPages;
      staffMediaDone = !conn?.pageInfo.hasNextPage || hitMaxPages;
      if (!staffMediaDone) {
        staffMediaPage += 1;
      }
    }
  }

  return {
    characterEdges,
    staffMediaEdges,
    characterPagesFetched,
    staffMediaPagesFetched,
    staff,
    staffExists,
  };
}

export async function persistStaffFilmographyExpansion(
  ctx: AnilistImportContext,
  staffId: number,
  characterEdges: AnilistStaffCharacterMediaEdgeGql[],
  staffMediaEdges: AnilistStaffMediaEdgeGql[],
  options: {
    voiceActorLanguage?: AnilistStaffLanguage;
    staffProfile: AnilistStaffGql | null;
    characterPagesFetched: number;
    staffMediaPagesFetched: number;
  },
): Promise<ExpandStaffFilmographyResult> {
  const language = options.voiceActorLanguage ?? DEFAULT_VOICE_ACTOR_LANGUAGE;
  const now = ctx.now();
  const appearance = mapStaffCharacterAppearanceData(staffId, characterEdges, language, now);
  const mediaStaffRows = mapStaffFilmographyMediaStaffRows(staffId, staffMediaEdges);
  const staffProfile = options.staffProfile;
  const fullMediaById = new Map(
    staffMediaEdges
      .map((edge) => edge.node)
      .filter((node) => node != null)
      .map((node) => [node.id, node] as const),
  );

  await persistMediaGraphCheckpoint(ctx, [...fullMediaById.values()]);

  const stmts: Array<{ sql: string; params: readonly SqlBindable[] }> = [
    {
      sql: 'DELETE FROM character_voice_actor WHERE staff_id = ? AND language = ?',
      params: [staffId, language],
    },
    {
      sql: 'DELETE FROM media_staff WHERE staff_id = ?',
      params: [staffId],
    },
  ];

  if (staffProfile) {
    stmts.push({
      sql: STAFF_UPSERT_SQL,
      params: staffRowToParams(mapStaffRow(staffProfile, now)),
    });
  }

  for (const row of appearance.mediaRows) {
    stmts.push({ sql: MEDIA_STUB_UPSERT_SQL, params: mediaStubRowToParams(row) });
  }
  for (const row of appearance.characterRows) {
    stmts.push({ sql: CHARACTER_STUB_UPSERT_SQL, params: characterStubRowToParams(row) });
  }
  for (const mc of appearance.mediaCharacterRows) {
    stmts.push({
      sql: 'INSERT OR IGNORE INTO media_character (media_id, character_id, role, sort_order) VALUES (?, ?, ?, ?)',
      params: [mc.media_id, mc.character_id, mc.role, mc.sort_order],
    });
  }
  for (const cva of appearance.cvaRows) {
    stmts.push({
      sql: 'INSERT OR IGNORE INTO character_voice_actor (media_id, character_id, staff_id, language) VALUES (?, ?, ?, ?)',
      params: [cva.media_id, cva.character_id, cva.staff_id, cva.language],
    });
  }
  for (const ms of mediaStaffRows) {
    stmts.push({
      sql: 'INSERT OR IGNORE INTO media_staff (media_id, staff_id, role, sort_order) VALUES (?, ?, ?, ?)',
      params: [ms.media_id, ms.staff_id, ms.role, ms.sort_order],
    });
  }

  stmts.push({
    sql: `INSERT INTO staff_filmography_expansion (staff_id, fetched_at)
          VALUES (?, ?)
          ON CONFLICT(staff_id) DO UPDATE SET fetched_at = excluded.fetched_at`,
    params: [staffId, now],
  });

  emitProgress(ctx.onProgress, { kind: 'writing', statements: stmts.length });
  await execBatchInChunks(ctx.db, stmts);

  if (fullMediaById.size === 0 && ctx.onDirtyIncrement) {
    await ctx.onDirtyIncrement();
  }

  emitProgress(ctx.onProgress, { kind: 'done' });

  const mediaIds = new Set<number>();
  for (const row of appearance.mediaRows) {
    mediaIds.add(row.id);
  }
  for (const e of staffMediaEdges) {
    if (e.node?.id) {
      mediaIds.add(e.node.id);
    }
  }

  return {
    staffId,
    characterPagesFetched: options.characterPagesFetched,
    staffMediaPagesFetched: options.staffMediaPagesFetched,
    mediaUpserted: mediaIds.size,
    mediaStaffWritten: mediaStaffRows.length,
    cvaWritten: appearance.cvaRows.length,
  };
}

export async function expandStaffFilmography(
  ctx: AnilistImportContext,
  staffId: number,
  options: ExpandStaffFilmographyOptions = {},
): Promise<ExpandStaffFilmographyResult | null> {
  const perPage = options.perPage ?? DEFAULT_FILMOGRAPHY_PER_PAGE;
  const language = options.voiceActorLanguage ?? DEFAULT_VOICE_ACTOR_LANGUAGE;

  const fetched = await fetchFilmographyPages(
    ctx,
    staffId,
    perPage,
    options.charactersMaxPages,
    options.staffMediaMaxPages,
    options.signal,
  );
  const characterEdges = fetched.characterEdges;
  const staffMediaEdges = fetched.staffMediaEdges;
  let staffProfile = fetched.staff;

  if (fetched.staffExists === false) {
    return null;
  }
  if (staffProfile === null) {
    options.signal?.throwIfAborted();
    const probe = await ctx.executeQuery<AnilistStaffFilmographyResponse>(
      buildStaffFilmographyQuery(),
      {
        id: staffId,
        charactersPage: 1,
        staffMediaPage: 1,
        perPage,
        includeCharacters: true,
        includeStaffMedia: true,
      },
    );
    if (!probe?.Staff) {
      return null;
    }
    staffProfile = staffProfile ?? probe.Staff;
  }

  return persistStaffFilmographyExpansion(ctx, staffId, characterEdges, staffMediaEdges, {
    voiceActorLanguage: language,
    staffProfile,
    characterPagesFetched: fetched.characterPagesFetched,
    staffMediaPagesFetched: fetched.staffMediaPagesFetched,
  });
}
