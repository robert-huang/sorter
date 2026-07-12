/**
 * Paginated `Staff.characters` + `Staff.staffMedia` fetch. Persists
 * adjacency into `media`, `media_staff`, `media_character`, CVA, etc.
 * `staff_filmography_expansion` is only a visit marker.
 */

import type { AnilistImportContext, SqlBindable } from './context';
import {
  mapMediaRow,
  mapStaffCharacterAppearanceData,
  mapStaffFilmographyMediaStaffRows,
} from './mappers';
import { MEDIA_UPSERT_SQL, mediaRowToParams } from './importer';
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
};

export type ExpandStaffFilmographyResult = {
  staffId: number;
  characterPagesFetched: number;
  staffMediaPagesFetched: number;
  mediaUpserted: number;
  mediaStaffWritten: number;
  cvaWritten: number;
};

async function fetchCharacterPages(
  ctx: AnilistImportContext,
  staffId: number,
  perPage: number,
  maxPages: number | undefined,
): Promise<{
  edges: AnilistStaffCharacterMediaEdgeGql[];
  pagesFetched: number;
  staff: AnilistStaffGql | null;
}> {
  const query = buildStaffFilmographyQuery();
  const allEdges: AnilistStaffCharacterMediaEdgeGql[] = [];
  let page = 1;
  let pagesFetched = 0;
  let hasNext = true;
  let staff: AnilistStaffGql | null = null;

  while (hasNext && (maxPages === undefined || pagesFetched < maxPages)) {
    const response = await ctx.executeQuery<AnilistStaffFilmographyResponse>(query, {
      id: staffId,
      charactersPage: page,
      staffMediaPage: 1,
      perPage,
    });
    if (!response?.Staff) {
      if (pagesFetched === 0) {
        return { edges: [], pagesFetched: 0, staff: null };
      }
      break;
    }
    if (staff === null) {
      staff = response.Staff;
    }
    pagesFetched += 1;
    const conn = response.Staff.characterMedia;
    if (conn) {
      allEdges.push(...conn.edges);
      hasNext = conn.pageInfo.hasNextPage;
    } else {
      hasNext = false;
    }
    emitProgress(ctx.onProgress, {
      kind: 'fetching-page',
      what: 'characters',
      page,
      itemsSoFar: allEdges.length,
    });
    page += 1;
  }

  return { edges: allEdges, pagesFetched, staff };
}

async function fetchStaffMediaPages(
  ctx: AnilistImportContext,
  staffId: number,
  perPage: number,
  maxPages: number | undefined,
): Promise<{
  edges: AnilistStaffMediaEdgeGql[];
  pagesFetched: number;
  staff: AnilistStaffGql | null;
}> {
  const query = buildStaffFilmographyQuery();
  const allEdges: AnilistStaffMediaEdgeGql[] = [];
  let page = 1;
  let pagesFetched = 0;
  let hasNext = true;
  let staff: AnilistStaffGql | null = null;

  while (hasNext && (maxPages === undefined || pagesFetched < maxPages)) {
    const response = await ctx.executeQuery<AnilistStaffFilmographyResponse>(query, {
      id: staffId,
      charactersPage: 1,
      staffMediaPage: page,
      perPage,
    });
    if (!response?.Staff) {
      if (pagesFetched === 0) {
        return { edges: [], pagesFetched: 0, staff: null };
      }
      break;
    }
    if (staff === null) {
      staff = response.Staff;
    }
    pagesFetched += 1;
    const conn = response.Staff.staffMedia;
    if (conn) {
      allEdges.push(...conn.edges);
      hasNext = conn.pageInfo.hasNextPage;
    } else {
      hasNext = false;
    }
    emitProgress(ctx.onProgress, {
      kind: 'fetching-page',
      what: 'staff',
      page,
      itemsSoFar: allEdges.length,
    });
    page += 1;
  }

  return { edges: allEdges, pagesFetched, staff };
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

  const stmts: Array<{ sql: string; params: readonly SqlBindable[] }> = [];

  if (staffProfile) {
    stmts.push({
      sql: STAFF_UPSERT_SQL,
      params: staffRowToParams(mapStaffRow(staffProfile, now)),
    });
  }

  for (const row of appearance.mediaRows) {
    stmts.push({ sql: MEDIA_STUB_UPSERT_SQL, params: mediaStubRowToParams(row) });
  }
  for (const e of staffMediaEdges) {
    const node = e.node;
    if (!node?.id) {
      continue;
    }
    stmts.push({
      sql: MEDIA_UPSERT_SQL,
      params: mediaRowToParams(mapMediaRow(node, now)),
    });
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
  await ctx.db.execBatch(stmts);

  if (ctx.onDirtyIncrement) {
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

  const charResult = await fetchCharacterPages(
    ctx,
    staffId,
    perPage,
    options.charactersMaxPages,
  );
  const staffMediaResult = await fetchStaffMediaPages(
    ctx,
    staffId,
    perPage,
    options.staffMediaMaxPages,
  );
  const characterEdges = charResult.edges;
  const staffMediaEdges = staffMediaResult.edges;
  let staffProfile = charResult.staff ?? staffMediaResult.staff;

  if (characterEdges.length === 0 && staffMediaEdges.length === 0) {
    const probe = await ctx.executeQuery<AnilistStaffFilmographyResponse>(
      buildStaffFilmographyQuery(),
      { id: staffId, charactersPage: 1, staffMediaPage: 1, perPage },
    );
    if (!probe?.Staff) {
      return null;
    }
    staffProfile = staffProfile ?? probe.Staff;
  }

  return persistStaffFilmographyExpansion(ctx, staffId, characterEdges, staffMediaEdges, {
    voiceActorLanguage: language,
    staffProfile,
    characterPagesFetched: charResult.pagesFetched,
    staffMediaPagesFetched: staffMediaResult.pagesFetched,
  });
}
