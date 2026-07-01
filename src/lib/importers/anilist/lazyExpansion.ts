/**
 * Per-media lazy character + staff expansion. Called from:
 *   - The Phase-D detail panel when it first opens for a media.
 *   - The per-entry refresh button (also in the detail panel).
 *
 * Pagination: two independent loops (characters, then staff) — never
 * a characters×staff cartesian product. See plan § cast pagination.
 */

import type { AnilistDbExecutor, AnilistImportContext, SqlBindable } from './context';
import { MEDIA_UPSERT_SQL, mediaRowToParams } from './importer';
import {
  mapCharacterRow,
  mapCharacterVoiceActorRows,
  mapMediaCharacterRows,
  mapMediaRow,
  mapMediaStaffRows,
  mapStaffRow,
} from './mappers';
import { emitProgress } from './progress';
import {
  buildAnimeByIdQuery,
  buildMediaDetailQuery,
  buildMediaStaffOnlyQuery,
} from './queries';
import type {
  AnilistAnimeByIdResponse,
  AnilistMediaCharacterEdgeGql,
  AnilistMediaDetailResponse,
  AnilistMediaStaffEdgeGql,
  AnilistMediaStaffOnlyResponse,
  AnilistStaffGql,
  AnilistStaffLanguage,
  CharacterRow,
  CharacterVoiceActorRow,
  MediaCharacterRow,
  MediaRow,
  MediaStaffRow,
  StaffRow,
} from './types';

export const DEFAULT_DETAIL_PER_PAGE = 25;
export const DEFAULT_VOICE_ACTOR_LANGUAGE: AnilistStaffLanguage = 'JAPANESE';

export type ExpandAnilistMediaDetailScope = 'all' | 'characters' | 'staff';

export type ExpandAnilistMediaDetailOptions = {
  perPage?: number;
  /**
   * Test-only cap on character pages. Production omits this — fetch until
   * `hasNextPage` is false.
   */
  charactersMaxPages?: number;
  /** Test-only cap on staff pages. */
  staffMaxPages?: number;
  voiceActorLanguage?: AnilistStaffLanguage;
  /** Which subgraph to refresh. Default `all`. */
  scope?: ExpandAnilistMediaDetailScope;
  /** Re-fetch even when completeness flags are already set. */
  force?: boolean;
};

export type ExpandAnilistMediaDetailResult = {
  mediaId: number;
  characterPagesFetched: number;
  staffPagesFetched: number;
  charactersWritten: number;
  staffCreditsWritten: number;
  staffWritten: number;
  voiceActorsWritten: number;
  charactersComplete: boolean;
  staffComplete: boolean;
};

export const CHARACTER_COLS = [
  'id',
  'name_full',
  'name_native',
  'name_alternatives_json',
  'name_alternatives_spoiler_json',
  'image',
  'age',
  'gender',
  'favourites',
  'birth_year',
  'birth_month',
  'birth_day',
  'fetched_at',
  'updated_at',
] as const;

export const STAFF_COLS = [
  'id',
  'name_full',
  'name_native',
  'image',
  'age',
  'gender',
  'language_v2',
  'favourites',
  'fetched_at',
  'updated_at',
] as const;

/**
 * Identity + display fields from `TOOLS_CHARACTER_VOICE_MEDIA_QUERY` only.
 * Does not touch metadata like `source` that full list/detail imports own.
 */
export const MEDIA_STUB_COLS = [
  'id',
  'type',
  'title_english',
  'title_romaji',
  'title_native',
  'cover_image',
  'format',
  'synonyms_json',
  'fetched_at',
  'updated_at',
] as const;

export type MediaStubRow = Pick<MediaRow, (typeof MEDIA_STUB_COLS)[number]>;

/** Identity-only staff upsert — does not touch profile fields like gender. */
export const STAFF_STUB_COLS = [
  'id',
  'name_full',
  'name_native',
  'image',
  'fetched_at',
  'updated_at',
] as const;

export type StaffStubRow = Pick<StaffRow, (typeof STAFF_STUB_COLS)[number]>;

/** Identity-only character upsert — does not touch profile fields like gender. */
export const CHARACTER_STUB_COLS = [
  'id',
  'name_full',
  'name_native',
  'name_alternatives_json',
  'name_alternatives_spoiler_json',
  'image',
  'fetched_at',
  'updated_at',
] as const;

export type CharacterStubRow = Pick<CharacterRow, (typeof CHARACTER_STUB_COLS)[number]>;

function buildPersonUpsertSql(table: string, cols: readonly string[]): string {
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates}`;
}

function buildCharacterUpsertSql(): string {
  const placeholders = CHARACTER_COLS.map(() => '?').join(', ');
  const updates = CHARACTER_COLS.filter((c) => c !== 'id')
    .map((c) => {
      if (c === 'birth_year' || c === 'birth_month' || c === 'birth_day') {
        return `${c} = COALESCE(excluded.${c}, character.${c})`;
      }
      return `${c} = excluded.${c}`;
    })
    .join(', ');
  return (
    `INSERT INTO character (${CHARACTER_COLS.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates}`
  );
}

function buildMediaStubUpsertSql(): string {
  const placeholders = MEDIA_STUB_COLS.map(() => '?').join(', ');
  const updates = MEDIA_STUB_COLS.filter((c) => c !== 'id')
    .map((c) => {
      if (c === 'cover_image' || c === 'synonyms_json') {
        return `${c} = COALESCE(excluded.${c}, media.${c})`;
      }
      return `${c} = excluded.${c}`;
    })
    .join(', ');
  return (
    `INSERT INTO media (${MEDIA_STUB_COLS.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates}`
  );
}

function buildStaffStubUpsertSql(): string {
  const placeholders = STAFF_STUB_COLS.map(() => '?').join(', ');
  const updates = STAFF_STUB_COLS.filter((c) => c !== 'id')
    .map((c) => {
      if (c === 'image') {
        return `${c} = COALESCE(excluded.${c}, staff.${c})`;
      }
      return `${c} = excluded.${c}`;
    })
    .join(', ');
  return (
    `INSERT INTO staff (${STAFF_STUB_COLS.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates}`
  );
}

function buildCharacterStubUpsertSql(): string {
  const placeholders = CHARACTER_STUB_COLS.map(() => '?').join(', ');
  const updates = CHARACTER_STUB_COLS.filter((c) => c !== 'id')
    .map((c) => {
      if (c === 'image') {
        return `${c} = COALESCE(excluded.${c}, character.${c})`;
      }
      return `${c} = excluded.${c}`;
    })
    .join(', ');
  return (
    `INSERT INTO character (${CHARACTER_STUB_COLS.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates}`
  );
}

export const CHARACTER_UPSERT_SQL = buildCharacterUpsertSql();
export const CHARACTER_STUB_UPSERT_SQL = buildCharacterStubUpsertSql();
export const MEDIA_STUB_UPSERT_SQL = buildMediaStubUpsertSql();
export const STAFF_UPSERT_SQL = buildPersonUpsertSql('staff', STAFF_COLS);
export const STAFF_STUB_UPSERT_SQL = buildStaffStubUpsertSql();

export function characterRowToParams(row: CharacterRow): SqlBindable[] {
  return CHARACTER_COLS.map((c) => row[c]);
}

export function staffRowToParams(row: StaffRow): SqlBindable[] {
  return STAFF_COLS.map((c) => row[c]);
}

export function staffStubRowToParams(row: StaffStubRow): SqlBindable[] {
  return STAFF_STUB_COLS.map((c) => row[c]);
}

export function mediaStubRowToParams(row: MediaStubRow): SqlBindable[] {
  return MEDIA_STUB_COLS.map((c) => row[c]);
}

export function characterStubRowToParams(row: CharacterStubRow): SqlBindable[] {
  return CHARACTER_STUB_COLS.map((c) => row[c]);
}

type ExpansionPatch = {
  charactersFetchedAt: number | null;
  staffFetchedAt: number | null;
  charactersComplete: boolean;
  staffComplete: boolean;
};

async function readExpansionPatch(
  ctx: AnilistImportContext,
  mediaId: number,
): Promise<ExpansionPatch | null> {
  const rows = await ctx.db.exec(
    `SELECT characters_fetched_at, staff_fetched_at, characters_complete, staff_complete
       FROM media_cast_expansion WHERE media_id = ?`,
    [mediaId],
  );
  if (rows.length === 0) {
    return null;
  }
  const r = rows[0];
  return {
    charactersFetchedAt:
      r.characters_fetched_at === null || r.characters_fetched_at === undefined
        ? null
        : Number(r.characters_fetched_at),
    staffFetchedAt:
      r.staff_fetched_at === null || r.staff_fetched_at === undefined
        ? null
        : Number(r.staff_fetched_at),
    charactersComplete: Number(r.characters_complete) === 1,
    staffComplete: Number(r.staff_complete) === 1,
  };
}

async function fetchCharacterPages(
  ctx: AnilistImportContext,
  mediaId: number,
  perPage: number,
  language: AnilistStaffLanguage,
  maxPages: number | undefined,
): Promise<{
  edges: AnilistMediaCharacterEdgeGql[];
  pagesFetched: number;
  complete: boolean;
} | null> {
  const query = buildMediaDetailQuery({ voiceActorLanguage: language });
  const allEdges: AnilistMediaCharacterEdgeGql[] = [];
  let page = 1;
  let pagesFetched = 0;
  let complete = false;
  let hasNext = true;

  while (hasNext && (maxPages === undefined || pagesFetched < maxPages)) {
    const response = await ctx.executeQuery<AnilistMediaDetailResponse>(query, {
      id: mediaId,
      charactersPage: page,
      staffPage: 1,
      perPage,
    });
    if (!response?.Media) {
      if (pagesFetched === 0) {
        return null;
      }
      break;
    }
    pagesFetched += 1;
    const conn = response.Media.characters;
    if (conn) {
      allEdges.push(...conn.edges);
      hasNext = conn.pageInfo.hasNextPage;
      if (!hasNext) {
        complete = true;
      }
    } else {
      hasNext = false;
      complete = true;
    }

    emitProgress(ctx.onProgress, {
      kind: 'fetching-page',
      what: 'characters',
      page,
      itemsSoFar: allEdges.length,
    });
    page += 1;
  }

  return { edges: allEdges, pagesFetched, complete };
}

async function fetchStaffPages(
  ctx: AnilistImportContext,
  mediaId: number,
  perPage: number,
  maxPages: number | undefined,
): Promise<{
  edges: AnilistMediaStaffEdgeGql[];
  pagesFetched: number;
  complete: boolean;
} | null> {
  const detailQuery = buildMediaDetailQuery({
    voiceActorLanguage: DEFAULT_VOICE_ACTOR_LANGUAGE,
  });
  const staffOnlyQuery = buildMediaStaffOnlyQuery();
  const allEdges: AnilistMediaStaffEdgeGql[] = [];
  let page = 1;
  let pagesFetched = 0;
  let complete = false;
  let hasNext = true;

  while (hasNext && (maxPages === undefined || pagesFetched < maxPages)) {
    const response =
      page === 1
        ? await ctx.executeQuery<AnilistMediaDetailResponse>(detailQuery, {
            id: mediaId,
            charactersPage: 1,
            staffPage: 1,
            perPage,
          })
        : await ctx.executeQuery<AnilistMediaStaffOnlyResponse>(staffOnlyQuery, {
            id: mediaId,
            staffPage: page,
            perPage,
          });

    if (!response?.Media) {
      if (pagesFetched === 0) {
        return null;
      }
      break;
    }

    pagesFetched += 1;
    const conn = response.Media.staff;
    if (conn) {
      allEdges.push(...conn.edges);
      hasNext = conn.pageInfo.hasNextPage;
      if (!hasNext) {
        complete = true;
      }
    } else {
      hasNext = false;
      complete = true;
    }

    emitProgress(ctx.onProgress, {
      kind: 'fetching-page',
      what: 'staff',
      page,
      itemsSoFar: allEdges.length,
    });
    page += 1;
  }

  return { edges: allEdges, pagesFetched, complete };
}

function collectStaffFromCharacters(
  edges: AnilistMediaCharacterEdgeGql[],
  now: number,
): Map<number, StaffRow> {
  const staffById = new Map<number, StaffRow>();
  for (const charEdge of edges) {
    for (const va of charEdge.voiceActors ?? []) {
      const row = mapStaffRow(va as AnilistStaffGql, now);
      staffById.set(row.id, row);
    }
  }
  return staffById;
}

function collectStaffFromStaffEdges(
  edges: AnilistMediaStaffEdgeGql[],
  now: number,
): Map<number, StaffRow> {
  const staffById = new Map<number, StaffRow>();
  for (const edge of edges) {
    const row = mapStaffRow(edge.node, now);
    staffById.set(row.id, row);
  }
  return staffById;
}

/**
 * Re-fetch full metadata for listed media that never had `source(version: 3)`
 * imported (stub clobber, pre-v3 row, or never touched). Idempotent — rows
 * with `source_fetched_at` set are skipped even when `source` IS NULL.
 */
export async function repairListedMediaNullSource(
  ctx: AnilistImportContext,
  anilistUserId: number,
): Promise<number> {
  const rows = await ctx.db.exec(
    `SELECT DISTINCT m.id
       FROM media m
       INNER JOIN media_list_entry mle ON mle.media_id = m.id
      WHERE mle.anilist_user_id = ?
        AND m.source_fetched_at IS NULL`,
    [anilistUserId],
  );
  let repaired = 0;
  for (const row of rows) {
    const mediaId = Number(row.id);
    await ensureMediaRowForCastExpansion(ctx, mediaId, { refreshMetadata: true });
    repaired += 1;
  }
  return repaired;
}

/** True when any listed anime row still needs a v3 source import. */
export async function listedMediaNeedsSourceRepair(
  db: AnilistDbExecutor,
  anilistUserId: number,
): Promise<boolean> {
  const rows = await db.exec(
    `SELECT 1
       FROM media m
       INNER JOIN media_list_entry mle ON mle.media_id = m.id
      WHERE mle.anilist_user_id = ?
        AND m.type = 'ANIME'
        AND m.source_fetched_at IS NULL
      LIMIT 1`,
    [anilistUserId],
  );
  return rows.length > 0;
}

/** Cast junction tables FK to `media` — fetch full metadata when missing or forced. */
async function ensureMediaRowForCastExpansion(
  ctx: AnilistImportContext,
  mediaId: number,
  options: { refreshMetadata?: boolean } = {},
): Promise<boolean> {
  const rows = await ctx.db.exec(
    'SELECT 1 FROM media WHERE id = ? LIMIT 1',
    [mediaId],
  );
  const exists = rows.length > 0;
  if (exists && !options.refreshMetadata) {
    return true;
  }

  const response = await ctx.executeQuery<AnilistAnimeByIdResponse>(
    buildAnimeByIdQuery(),
    { id: mediaId },
  );
  if (!response?.Media) {
    return exists;
  }

  const row = mapMediaRow(response.Media, ctx.now());
  await ctx.db.execBatch([
    { sql: MEDIA_UPSERT_SQL, params: mediaRowToParams(row) },
  ]);
  if (ctx.onDirtyIncrement) {
    await ctx.onDirtyIncrement();
  }
  return true;
}

export async function expandAnilistMediaDetail(
  ctx: AnilistImportContext,
  mediaId: number,
  options: ExpandAnilistMediaDetailOptions = {},
): Promise<ExpandAnilistMediaDetailResult | null> {
  const perPage = options.perPage ?? DEFAULT_DETAIL_PER_PAGE;
  const language = options.voiceActorLanguage ?? DEFAULT_VOICE_ACTOR_LANGUAGE;
  const scope = options.scope ?? 'all';
  const now = ctx.now();

  if (!(await ensureMediaRowForCastExpansion(ctx, mediaId, { refreshMetadata: options.force }))) {
    return null;
  }

  const existing = await readExpansionPatch(ctx, mediaId);

  let characterEdges: AnilistMediaCharacterEdgeGql[] = [];
  let staffEdges: AnilistMediaStaffEdgeGql[] = [];
  let characterPagesFetched = 0;
  let staffPagesFetched = 0;
  let charactersComplete = existing?.charactersComplete ?? false;
  let staffComplete = existing?.staffComplete ?? false;
  let charactersFetchedAt = existing?.charactersFetchedAt ?? null;
  let staffFetchedAt = existing?.staffFetchedAt ?? null;

  if (scope === 'all' || scope === 'characters') {
    const charResult = await fetchCharacterPages(
      ctx,
      mediaId,
      perPage,
      language,
      options.charactersMaxPages,
    );
    if (!charResult) {
      return null;
    }
    characterEdges = charResult.edges;
    characterPagesFetched = charResult.pagesFetched;
    charactersComplete = charResult.complete;
    charactersFetchedAt = now;
  }

  if (scope === 'all' || scope === 'staff') {
    const staffResult = await fetchStaffPages(
      ctx,
      mediaId,
      perPage,
      options.staffMaxPages,
    );
    if (!staffResult) {
      if (scope === 'staff') {
        return null;
      }
    } else {
      staffEdges = staffResult.edges;
      staffPagesFetched = staffResult.pagesFetched;
      staffComplete = staffResult.complete;
      staffFetchedAt = now;
    }
  }

  const nowTs = ctx.now();
  const characterRows: CharacterRow[] = characterEdges.map((e) =>
    mapCharacterRow(e.node, nowTs),
  );
  const mediaCharacterRows: MediaCharacterRow[] = mapMediaCharacterRows(
    mediaId,
    characterEdges,
  );
  const voiceActorRows: CharacterVoiceActorRow[] = mapCharacterVoiceActorRows(
    mediaId,
    characterEdges,
    language,
  );
  const mediaStaffRows: MediaStaffRow[] = mapMediaStaffRows(mediaId, staffEdges);

  const staffFromCharacters = new Map<number, StaffRow>();
  const staffFromStaffEdges = new Map<number, StaffRow>();
  if (scope === 'all' || scope === 'characters') {
    for (const [id, row] of collectStaffFromCharacters(characterEdges, nowTs)) {
      staffFromCharacters.set(id, row);
    }
  }
  if (scope === 'all' || scope === 'staff') {
    for (const [id, row] of collectStaffFromStaffEdges(staffEdges, nowTs)) {
      staffFromStaffEdges.set(id, row);
    }
  }

  const stmts: Array<{ sql: string; params: readonly SqlBindable[] }> = [];

  if (scope === 'all' || scope === 'characters') {
    stmts.push({
      sql: 'DELETE FROM media_character WHERE media_id = ?',
      params: [mediaId],
    });
  }
  if (scope === 'all' || scope === 'staff') {
    stmts.push({
      sql: 'DELETE FROM media_staff WHERE media_id = ?',
      params: [mediaId],
    });
  }

  for (const row of characterRows) {
    stmts.push({ sql: CHARACTER_UPSERT_SQL, params: characterRowToParams(row) });
  }
  for (const [id, row] of staffFromCharacters) {
    if (!staffFromStaffEdges.has(id)) {
      stmts.push({ sql: STAFF_STUB_UPSERT_SQL, params: staffStubRowToParams(row) });
    }
  }
  for (const row of staffFromStaffEdges.values()) {
    stmts.push({ sql: STAFF_UPSERT_SQL, params: staffRowToParams(row) });
  }

  for (const mc of mediaCharacterRows) {
    stmts.push({
      sql: 'INSERT INTO media_character (media_id, character_id, role, sort_order) VALUES (?, ?, ?, ?)',
      params: [mc.media_id, mc.character_id, mc.role, mc.sort_order],
    });
  }
  for (const cva of voiceActorRows) {
    stmts.push({
      sql: 'INSERT INTO character_voice_actor (media_id, character_id, staff_id, language) VALUES (?, ?, ?, ?)',
      params: [cva.media_id, cva.character_id, cva.staff_id, cva.language],
    });
  }
  for (const ms of mediaStaffRows) {
    stmts.push({
      sql: 'INSERT OR IGNORE INTO media_staff (media_id, staff_id, role, sort_order) VALUES (?, ?, ?, ?)',
      params: [ms.media_id, ms.staff_id, ms.role, ms.sort_order],
    });
  }

  const legacyFetchedAt = Math.max(
    charactersFetchedAt ?? 0,
    staffFetchedAt ?? 0,
    existing ? 0 : now,
  );

  stmts.push({
    sql: `INSERT INTO media_cast_expansion (
      media_id, language, fetched_at,
      characters_fetched_at, staff_fetched_at,
      characters_complete, staff_complete
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET
      language = excluded.language,
      fetched_at = MAX(media_cast_expansion.fetched_at, excluded.fetched_at),
      characters_fetched_at = COALESCE(excluded.characters_fetched_at, media_cast_expansion.characters_fetched_at),
      staff_fetched_at = COALESCE(excluded.staff_fetched_at, media_cast_expansion.staff_fetched_at),
      characters_complete = CASE
        WHEN excluded.characters_fetched_at IS NOT NULL
        THEN excluded.characters_complete
        ELSE media_cast_expansion.characters_complete
      END,
      staff_complete = CASE
        WHEN excluded.staff_fetched_at IS NOT NULL
        THEN excluded.staff_complete
        ELSE media_cast_expansion.staff_complete
      END`,
    params: [
      mediaId,
      language,
      legacyFetchedAt,
      charactersFetchedAt,
      staffFetchedAt,
      charactersComplete ? 1 : 0,
      staffComplete ? 1 : 0,
    ],
  });

  emitProgress(ctx.onProgress, { kind: 'writing', statements: stmts.length });
  await ctx.db.execBatch(stmts);

  if (ctx.onDirtyIncrement) {
    await ctx.onDirtyIncrement();
  }

  emitProgress(ctx.onProgress, { kind: 'done' });
  const staffWritten = new Set([
    ...staffFromCharacters.keys(),
    ...staffFromStaffEdges.keys(),
  ]).size;
  return {
    mediaId,
    characterPagesFetched,
    staffPagesFetched,
    charactersWritten: mediaCharacterRows.length,
    staffCreditsWritten: mediaStaffRows.length,
    staffWritten,
    voiceActorsWritten: voiceActorRows.length,
    charactersComplete,
    staffComplete,
  };
}
