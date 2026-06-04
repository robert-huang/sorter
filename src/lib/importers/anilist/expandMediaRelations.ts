/**
 * Lazy `Media.relations` fetch — franchise edges for anime-to-anime relations mode.
 */

import type { AnilistImportContext, SqlBindable } from './context';
import { mapMediaRow } from './mappers';
import { MEDIA_UPSERT_SQL, mediaRowToParams } from './importer';
import { emitProgress } from './progress';
import { buildMediaRelationsQuery } from './queries';
import type { AnilistMediaRelationsResponse } from './types';

export type ExpandMediaRelationsResult = {
  fromMediaId: number;
  relationsWritten: number;
  mediaUpserted: number;
};

export async function expandMediaRelations(
  ctx: AnilistImportContext,
  mediaId: number,
): Promise<ExpandMediaRelationsResult | null> {
  const response = await ctx.executeQuery<AnilistMediaRelationsResponse>(
    buildMediaRelationsQuery(),
    { id: mediaId },
  );
  if (!response?.Media) {
    return null;
  }

  const now = ctx.now();
  const edges = response.Media.relations?.edges ?? [];
  const seen = new Set<string>();
  const stmts: Array<{ sql: string; params: readonly SqlBindable[] }> = [];
  const mediaById = new Map<number, ReturnType<typeof mapMediaRow>>();

  for (const e of edges) {
    const toId = e.node.id;
    const relationType = (e.relationType ?? '').trim() || 'OTHER';
    const key = `${toId}\0${relationType}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!mediaById.has(toId)) {
      mediaById.set(toId, mapMediaRow(e.node, now));
    }
    stmts.push({
      sql: `INSERT OR IGNORE INTO media_relation (from_media_id, to_media_id, relation_type)
            VALUES (?, ?, ?)`,
      params: [mediaId, toId, relationType],
    });
  }

  for (const row of mediaById.values()) {
    stmts.push({ sql: MEDIA_UPSERT_SQL, params: mediaRowToParams(row) });
  }

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
