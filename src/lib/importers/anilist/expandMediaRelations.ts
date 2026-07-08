/**
 * Lazy `Media.relations` fetch — franchise edges for anime-to-anime relations mode.
 */

import type { AnilistImportContext, SqlBindable } from './context';
import { mapMediaRow } from './mappers';
import { MEDIA_CHART_STUB_UPSERT_SQL, mediaChartStubRowToParams } from './lazyExpansion';
import { emitProgress } from './progress';
import { buildMediaRelationsQuery } from './queries';
import type { AnilistMediaRelationsResponse, AnilistMediaType } from './types';

export type ExpandMediaRelationsResult = {
  fromMediaId: number;
  relationsWritten: number;
  mediaUpserted: number;
};

export type ExpandMediaRelationsOptions = {
  /** Caller already fetched — skip network. */
  response?: AnilistMediaRelationsResponse;
};

export async function expandMediaRelations(
  ctx: AnilistImportContext,
  mediaId: number,
  options: ExpandMediaRelationsOptions = {},
): Promise<ExpandMediaRelationsResult | null> {
  const response =
    options.response ??
    (await ctx.executeQuery<AnilistMediaRelationsResponse>(
      buildMediaRelationsQuery(),
      { id: mediaId },
    ));
  if (!response?.Media) {
    return null;
  }

  const now = ctx.now();
  const edges = response.Media.relations?.edges ?? [];
  const seen = new Set<string>();
  const stmts: Array<{ sql: string; params: readonly SqlBindable[] }> = [];
  const edgeStmts: Array<{ sql: string; params: readonly SqlBindable[] }> = [];
  const mediaById = new Map<number, ReturnType<typeof mapMediaRow>>();

  const seedGql = response.Media as unknown as {
    title?: { english?: string | null };
    type?: AnilistMediaType | null;
  };

  // A fresh response is the authoritative complete edge set for this seed, so
  // always replace outbound edges — otherwise relations removed on AniList
  // would linger forever (INSERT OR IGNORE never deletes).
  stmts.push({
    sql: 'DELETE FROM media_relation WHERE from_media_id = ?',
    params: [mediaId],
  });

  // FK targets must exist before edge/marker inserts. OR IGNORE keeps rich
  // seed rows from list import when the relations query only returns id.
  stmts.push({
    sql: `INSERT OR IGNORE INTO media (id, type, fetched_at, updated_at)
          VALUES (?, ?, ?, ?)`,
    params: [mediaId, seedGql.type ?? 'ANIME', now, now],
  });

  if (seedGql.title != null) {
    mediaById.set(mediaId, mapMediaRow(response.Media as never, now));
  }

  for (const e of edges) {
    const toId = e.node.id;
    const relationType = (e.relationType ?? '').trim().toUpperCase() || 'OTHER';
    const key = `${toId}\0${relationType}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!mediaById.has(toId)) {
      mediaById.set(toId, mapMediaRow(e.node, now));
    }
    edgeStmts.push({
      sql: `INSERT OR IGNORE INTO media_relation (from_media_id, to_media_id, relation_type)
            VALUES (?, ?, ?)`,
      params: [mediaId, toId, relationType],
    });
  }

  // Chart-scoped upsert: refreshes title/cover/format/start-date without
  // clobbering list-owned metadata (source, mean_score, genres, ...).
  for (const row of mediaById.values()) {
    stmts.push({ sql: MEDIA_CHART_STUB_UPSERT_SQL, params: mediaChartStubRowToParams(row) });
  }
  stmts.push(...edgeStmts);

  stmts.push({
    sql: `INSERT INTO media_relations_expansion (media_id, fetched_at)
          VALUES (?, ?)
          ON CONFLICT(media_id) DO UPDATE SET fetched_at = excluded.fetched_at`,
    params: [mediaId, now],
  });

  emitProgress(ctx.onProgress, { kind: 'writing', statements: stmts.length });
  await ctx.db.execBatch(stmts);

  if (ctx.onDirtyIncrement) {
    await ctx.onDirtyIncrement();
  }

  emitProgress(ctx.onProgress, { kind: 'done' });

  return {
    fromMediaId: mediaId,
    relationsWritten: seen.size,
    mediaUpserted: mediaById.size,
  };
}
