/**
 * Paginated `Character.media` fetch for Favourites. Persists media,
 * staff, media_character, and JP CVA rows; `character_media_expansion`
 * is only a visit marker.
 */

import type { AnilistImportContext, SqlBindable } from './context';
import { mapCharacterMediaAppearanceData } from './mappers';
import {
  DEFAULT_VOICE_ACTOR_LANGUAGE,
  MEDIA_STUB_UPSERT_SQL,
  mediaStubRowToParams,
  STAFF_STUB_UPSERT_SQL,
  staffStubRowToParams,
} from './lazyExpansion';
import { emitProgress } from './progress';
import { TOOLS_CHARACTER_VOICE_MEDIA_QUERY } from './queries';
import type {
  AnilistCharacterMediaEdgeGql,
  AnilistCharacterVoiceMediaResponse,
  AnilistStaffLanguage,
} from './types';

export const DEFAULT_CHARACTER_MEDIA_PER_PAGE = 50;

export type ExpandCharacterMediaOptions = {
  perPage?: number;
  maxPages?: number;
  voiceActorLanguage?: AnilistStaffLanguage;
  /** Re-fetch even when a visit marker already exists. */
  force?: boolean;
};

export type ExpandCharacterMediaResult = {
  characterId: number;
  pagesFetched: number;
  mediaUpserted: number;
  cvaWritten: number;
};

async function fetchCharacterMediaPages(
  ctx: AnilistImportContext,
  characterId: number,
  perPage: number,
  maxPages: number | undefined,
): Promise<{ edges: AnilistCharacterMediaEdgeGql[]; pagesFetched: number }> {
  const allEdges: AnilistCharacterMediaEdgeGql[] = [];
  let page = 1;
  let pagesFetched = 0;
  let hasNext = true;

  while (hasNext && (maxPages === undefined || pagesFetched < maxPages)) {
    const response = await ctx.executeQuery<AnilistCharacterVoiceMediaResponse>(
      TOOLS_CHARACTER_VOICE_MEDIA_QUERY,
      { id: characterId, page, perPage },
    );
    if (!response?.Character) {
      if (pagesFetched === 0) {
        return { edges: [], pagesFetched: 0 };
      }
      break;
    }
    pagesFetched += 1;
    const conn = response.Character.media;
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

  return { edges: allEdges, pagesFetched };
}

export async function persistCharacterMediaExpansion(
  ctx: AnilistImportContext,
  characterId: number,
  edges: AnilistCharacterMediaEdgeGql[],
  options: {
    voiceActorLanguage?: AnilistStaffLanguage;
    pagesFetched: number;
  },
): Promise<ExpandCharacterMediaResult> {
  const language = options.voiceActorLanguage ?? DEFAULT_VOICE_ACTOR_LANGUAGE;
  const now = ctx.now();
  const appearance = mapCharacterMediaAppearanceData(characterId, edges, language, now);
  const stmts: Array<{ sql: string; params: readonly SqlBindable[] }> = [];

  for (const row of appearance.mediaRows) {
    stmts.push({ sql: MEDIA_STUB_UPSERT_SQL, params: mediaStubRowToParams(row) });
  }
  for (const row of appearance.staffRows) {
    stmts.push({ sql: STAFF_STUB_UPSERT_SQL, params: staffStubRowToParams(row) });
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

  stmts.push({
    sql: `INSERT INTO character_media_expansion (character_id, fetched_at)
          VALUES (?, ?)
          ON CONFLICT(character_id) DO UPDATE SET fetched_at = excluded.fetched_at`,
    params: [characterId, now],
  });

  emitProgress(ctx.onProgress, { kind: 'writing', statements: stmts.length });
  await ctx.db.execBatch(stmts);

  if (ctx.onDirtyIncrement) {
    await ctx.onDirtyIncrement();
  }

  emitProgress(ctx.onProgress, { kind: 'done' });

  return {
    characterId,
    pagesFetched: options.pagesFetched,
    mediaUpserted: appearance.mediaRows.length,
    cvaWritten: appearance.cvaRows.length,
  };
}

export async function expandCharacterMedia(
  ctx: AnilistImportContext,
  characterId: number,
  options: ExpandCharacterMediaOptions = {},
): Promise<ExpandCharacterMediaResult | null> {
  const perPage = options.perPage ?? DEFAULT_CHARACTER_MEDIA_PER_PAGE;
  const language = options.voiceActorLanguage ?? DEFAULT_VOICE_ACTOR_LANGUAGE;

  const { edges, pagesFetched } = await fetchCharacterMediaPages(
    ctx,
    characterId,
    perPage,
    options.maxPages,
  );

  if (edges.length === 0) {
    const probe = await ctx.executeQuery<AnilistCharacterVoiceMediaResponse>(
      TOOLS_CHARACTER_VOICE_MEDIA_QUERY,
      { id: characterId, page: 1, perPage },
    );
    if (!probe?.Character) {
      return null;
    }
  }

  return persistCharacterMediaExpansion(ctx, characterId, edges, {
    voiceActorLanguage: language,
    pagesFetched,
  });
}
