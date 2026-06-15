/**
 * In-memory 0-1 BFS over cached AniList SQLite adjacency for optimal path lookup.
 */

import type { AnilistDbExecutor } from '../lib/importers/anilist/context';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { pickPersonName } from '../lib/importers/anilist/personDisplayLabel';
import { filterProductionStaffRows } from '../lib/importers/anilist/staffRoleFilter';
import type { RoundConfig } from './preferences';
import type { PathStep } from './pathHistory';
import { annotatePathViaLabels } from './pathHopLabels';

export type FindCachedOptimalPathParams = {
  db: AnilistDbExecutor;
  startMediaId: number;
  goalMediaId: number;
  rules: RoundConfig;
  /** When set, BFS stops expanding past this link count. Omit for unbounded search. */
  maxLinks?: number;
};

export type CachedOptimalPathResult =
  | { status: 'found'; linksUsed: number; steps: PathStep[] }
  | { status: 'not_found' }
  | { status: 'same' };

type NodeKind = 'anime' | 'staff';

type GraphNode = { kind: NodeKind; id: number };

type CachedAdjacency = {
  animeToStaff: Map<number, Set<number>>;
  staffToAnime: Map<number, Set<number>>;
  animeToAnime: Map<number, Set<number>>;
};

type BfsParent = GraphNode | null;

function nodeKey(kind: NodeKind, id: number): string {
  return `${kind}:${id}`;
}

function addToAdjacency(map: Map<number, Set<number>>, from: number, to: number): void {
  let set = map.get(from);
  if (!set) {
    set = new Set();
    map.set(from, set);
  }
  set.add(to);
}

function productionRoleMode(rules: RoundConfig): 'key' | 'all' {
  return rules.productionAllRoles ? 'all' : 'key';
}

async function loadCachedAdjacency(
  db: AnilistDbExecutor,
  rules: RoundConfig,
): Promise<CachedAdjacency> {
  const roleMode = productionRoleMode(rules);
  const animeToStaff = new Map<number, Set<number>>();
  const staffToAnime = new Map<number, Set<number>>();
  const animeToAnime = new Map<number, Set<number>>();

  const cvaRows = await db.exec(`
    SELECT cva.media_id, cva.staff_id
    FROM character_voice_actor cva
    JOIN media m ON m.id = cva.media_id AND m.type = 'ANIME'
  `);

  for (const row of cvaRows) {
    const mediaId = Number(row.media_id);
    const staffId = Number(row.staff_id);
    addToAdjacency(animeToStaff, mediaId, staffId);
    addToAdjacency(staffToAnime, staffId, mediaId);
  }

  const staffRows = await db.exec(`
    SELECT ms.media_id, ms.staff_id, ms.role
    FROM media_staff ms
    JOIN media m ON m.id = ms.media_id AND m.type = 'ANIME'
  `);

  const filteredProduction = filterProductionStaffRows(
    staffRows.map((row) => ({
      mediaId: Number(row.media_id),
      staffId: Number(row.staff_id),
      role: row.role === null || row.role === undefined ? null : String(row.role),
    })),
    roleMode,
  );

  for (const row of filteredProduction) {
    if (rules.allowProduction) {
      addToAdjacency(animeToStaff, row.mediaId, row.staffId);
    }
    addToAdjacency(staffToAnime, row.staffId, row.mediaId);
  }

  if (rules.allowRelations) {
    const relationRows = await db.exec(`
      SELECT mr.from_media_id, mr.to_media_id
      FROM media_relation mr
      JOIN media m1 ON m1.id = mr.from_media_id AND m1.type = 'ANIME'
      JOIN media m2 ON m2.id = mr.to_media_id AND m2.type = 'ANIME'
    `);

    for (const row of relationRows) {
      const fromId = Number(row.from_media_id);
      const toId = Number(row.to_media_id);
      addToAdjacency(animeToAnime, fromId, toId);
      addToAdjacency(animeToAnime, toId, fromId);
    }
  }

  return { animeToStaff, staffToAnime, animeToAnime };
}

async function findSharedVaStaff(
  db: AnilistDbExecutor,
  startMediaId: number,
  goalMediaId: number,
): Promise<number | null> {
  const rows = await db.exec(
    `
      SELECT cva1.staff_id AS staff_id
      FROM character_voice_actor cva1
      JOIN character_voice_actor cva2 ON cva1.staff_id = cva2.staff_id
      WHERE cva1.media_id = ? AND cva2.media_id = ?
      LIMIT 1
    `,
    [startMediaId, goalMediaId],
  );
  if (rows.length === 0) {
    return null;
  }
  return Number(rows[0].staff_id);
}

async function findSharedProductionStaff(
  db: AnilistDbExecutor,
  startMediaId: number,
  goalMediaId: number,
  rules: RoundConfig,
): Promise<number | null> {
  if (!rules.allowProduction) {
    return null;
  }

  const rows = await db.exec(
    `
      SELECT ms1.staff_id AS staff_id, ms1.role AS role
      FROM media_staff ms1
      JOIN media_staff ms2 ON ms1.staff_id = ms2.staff_id
      WHERE ms1.media_id = ? AND ms2.media_id = ?
    `,
    [startMediaId, goalMediaId],
  );

  const roleMode = productionRoleMode(rules);
  const filtered = filterProductionStaffRows(
    rows.map((row) => ({
      staffId: Number(row.staff_id),
      role: row.role === null || row.role === undefined ? null : String(row.role),
    })),
    roleMode,
  );

  return filtered.length > 0 ? filtered[0].staffId : null;
}

async function hasDirectFranchiseLink(
  db: AnilistDbExecutor,
  startMediaId: number,
  goalMediaId: number,
  rules: RoundConfig,
): Promise<boolean> {
  if (!rules.allowRelations) {
    return false;
  }

  const rows = await db.exec(
    `
      SELECT 1
      FROM media_relation mr
      JOIN media m1 ON m1.id = mr.from_media_id AND m1.type = 'ANIME'
      JOIN media m2 ON m2.id = mr.to_media_id AND m2.type = 'ANIME'
      WHERE (mr.from_media_id = ? AND mr.to_media_id = ?)
         OR (mr.from_media_id = ? AND mr.to_media_id = ?)
      LIMIT 1
    `,
    [startMediaId, goalMediaId, goalMediaId, startMediaId],
  );
  return rows.length > 0;
}

async function hydratePathSteps(
  db: AnilistDbExecutor,
  nodes: readonly GraphNode[],
  rules?: RoundConfig,
): Promise<PathStep[]> {
  const mediaIds = [...new Set(nodes.filter((n) => n.kind === 'anime').map((n) => n.id))];
  const staffIds = [...new Set(nodes.filter((n) => n.kind === 'staff').map((n) => n.id))];

  const mediaById = new Map<number, PathStep & { kind: 'anime' }>();
  const staffById = new Map<number, PathStep & { kind: 'staff' }>();

  if (mediaIds.length > 0) {
    const placeholders = mediaIds.map(() => '?').join(', ');
    const rows = await db.exec(
      `SELECT id, title_romaji, title_english, title_native, cover_image
       FROM media WHERE id IN (${placeholders})`,
      mediaIds,
    );
    for (const row of rows) {
      const id = Number(row.id);
      mediaById.set(id, {
        kind: 'anime',
        mediaId: id,
        title: pickMediaTitle({
          id,
          title_romaji: row.title_romaji as string | null,
          title_english: row.title_english as string | null,
          title_native: row.title_native as string | null,
        }),
        coverImage: row.cover_image as string | null,
      });
    }
  }

  if (staffIds.length > 0) {
    const placeholders = staffIds.map(() => '?').join(', ');
    const rows = await db.exec(
      `SELECT id, name_full, name_native, image FROM staff WHERE id IN (${placeholders})`,
      staffIds,
    );
    for (const row of rows) {
      const id = Number(row.id);
      staffById.set(id, {
        kind: 'staff',
        staffId: id,
        name: pickPersonName(
          {
            id,
            name_full: row.name_full as string | null,
            name_native: row.name_native as string | null,
          },
          undefined,
          'Staff',
        ),
        image: row.image as string | null,
      });
    }
  }

  const steps = nodes.map((node) => {
    if (node.kind === 'anime') {
      const step = mediaById.get(node.id);
      if (!step) {
        return {
          kind: 'anime' as const,
          mediaId: node.id,
          title: `Anime ${node.id}`,
          coverImage: null,
        };
      }
      return step;
    }
    const step = staffById.get(node.id);
    if (!step) {
      return {
        kind: 'staff' as const,
        staffId: node.id,
        name: `Staff ${node.id}`,
        image: null,
      };
    }
    return step;
  });

  if (!rules) {
    return steps;
  }
  return annotatePathViaLabels(db, nodes, steps, rules);
}

async function buildOneLinkPath(
  db: AnilistDbExecutor,
  startMediaId: number,
  goalMediaId: number,
  viaStaffId: number | null,
  rules: RoundConfig,
): Promise<PathStep[]> {
  const nodes: GraphNode[] = [{ kind: 'anime', id: startMediaId }];
  if (viaStaffId !== null) {
    nodes.push({ kind: 'staff', id: viaStaffId });
  }
  nodes.push({ kind: 'anime', id: goalMediaId });
  return hydratePathSteps(db, nodes, rules);
}

async function tryDirectOneLinkPath(
  db: AnilistDbExecutor,
  startMediaId: number,
  goalMediaId: number,
  rules: RoundConfig,
): Promise<CachedOptimalPathResult | null> {
  if (await hasDirectFranchiseLink(db, startMediaId, goalMediaId, rules)) {
    const steps = await buildOneLinkPath(db, startMediaId, goalMediaId, null, rules);
    return { status: 'found', linksUsed: 1, steps };
  }

  const sharedVa = await findSharedVaStaff(db, startMediaId, goalMediaId);
  if (sharedVa !== null) {
    const steps = await buildOneLinkPath(db, startMediaId, goalMediaId, sharedVa, rules);
    return { status: 'found', linksUsed: 1, steps };
  }

  const sharedProd = await findSharedProductionStaff(db, startMediaId, goalMediaId, rules);
  if (sharedProd !== null) {
    const steps = await buildOneLinkPath(db, startMediaId, goalMediaId, sharedProd, rules);
    return { status: 'found', linksUsed: 1, steps };
  }

  return null;
}

function runZeroOneBfs(
  adjacency: CachedAdjacency,
  startMediaId: number,
  goalMediaId: number,
  maxLinks: number | undefined,
): GraphNode[] | null {
  const linkLimit = maxLinks ?? Number.POSITIVE_INFINITY;
  if (maxLinks !== undefined && maxLinks <= 0) {
    return null;
  }

  const start: GraphNode = { kind: 'anime', id: startMediaId };
  const visited = new Map<string, number>();
  const parents = new Map<string, BfsParent>();
  const deque: { node: GraphNode; linksUsed: number }[] = [{ node: start, linksUsed: 0 }];
  visited.set(nodeKey('anime', startMediaId), 0);
  parents.set(nodeKey('anime', startMediaId), null);

  while (deque.length > 0) {
    const current = deque.shift()!;
    const { node, linksUsed } = current;

    if (node.kind === 'anime' && node.id === goalMediaId) {
      const path: GraphNode[] = [];
      let cursor: GraphNode | null = node;
      while (cursor) {
        path.push(cursor);
        const parent: BfsParent = parents.get(nodeKey(cursor.kind, cursor.id)) ?? null;
        cursor = parent;
      }
      path.reverse();
      return path;
    }

    if (linksUsed >= linkLimit) {
      continue;
    }

    if (node.kind === 'anime') {
      const staffSet = adjacency.animeToStaff.get(node.id);
      if (staffSet) {
        for (const staffId of staffSet) {
          enqueueNode(deque, visited, parents, { kind: 'staff', id: staffId }, linksUsed, node);
        }
      }

      const relatedSet = adjacency.animeToAnime.get(node.id);
      if (relatedSet) {
        for (const mediaId of relatedSet) {
          enqueueNode(
            deque,
            visited,
            parents,
            { kind: 'anime', id: mediaId },
            linksUsed + 1,
            node,
            true,
          );
        }
      }
    } else {
      const animeSet = adjacency.staffToAnime.get(node.id);
      if (animeSet) {
        for (const mediaId of animeSet) {
          enqueueNode(
            deque,
            visited,
            parents,
            { kind: 'anime', id: mediaId },
            linksUsed + 1,
            node,
            true,
          );
        }
      }
    }
  }

  return null;
}

function enqueueNode(
  deque: { node: GraphNode; linksUsed: number }[],
  visited: Map<string, number>,
  parents: Map<string, BfsParent>,
  node: GraphNode,
  linksUsed: number,
  parent: GraphNode,
  pushBack = false,
): void {
  const key = nodeKey(node.kind, node.id);
  const previous = visited.get(key);
  if (previous !== undefined && previous <= linksUsed) {
    return;
  }
  visited.set(key, linksUsed);
  parents.set(key, parent);
  const entry = { node, linksUsed };
  if (pushBack) {
    deque.push(entry);
  } else {
    deque.unshift(entry);
  }
}

/** One pull from a {@link CachedShortestPathStream}. */
export type CachedPathStreamResult =
  | { status: 'found'; linksUsed: number; steps: PathStep[] }
  | { status: 'exhausted'; total: number };

/**
 * Lazily yields every distinct shortest start→goal path in the cached
 * graph, one per `next()` call, all of length {@link optimalLinks}.
 * Paths are NOT deduped by anime: reaching the same anime through a
 * different staff member is a distinct path and is yielded separately.
 * `next()` returns `exhausted` once all shortest paths have been seen.
 */
export type CachedShortestPathStream = {
  /** Link count shared by every path this stream yields (the cache optimum). */
  optimalLinks: number;
  next: () => Promise<CachedPathStreamResult>;
};

export type BuildCachedShortestPathStream =
  | { status: 'ready'; stream: CachedShortestPathStream }
  | { status: 'not_found' }
  | { status: 'same' };

type WeightedNeighbor = { node: GraphNode; weight: number };

/** Outgoing edges for a node, mirroring the 0-1 BFS expansion rules:
 *  anime→staff is free (0), staff→anime and anime→anime cost 1. */
function neighborsOf(adjacency: CachedAdjacency, node: GraphNode): WeightedNeighbor[] {
  const out: WeightedNeighbor[] = [];
  if (node.kind === 'anime') {
    const staffSet = adjacency.animeToStaff.get(node.id);
    if (staffSet) {
      for (const staffId of staffSet) {
        out.push({ node: { kind: 'staff', id: staffId }, weight: 0 });
      }
    }
    const relatedSet = adjacency.animeToAnime.get(node.id);
    if (relatedSet) {
      for (const mediaId of relatedSet) {
        out.push({ node: { kind: 'anime', id: mediaId }, weight: 1 });
      }
    }
  } else {
    const animeSet = adjacency.staffToAnime.get(node.id);
    if (animeSet) {
      for (const mediaId of animeSet) {
        out.push({ node: { kind: 'anime', id: mediaId }, weight: 1 });
      }
    }
  }
  return out;
}

/** 0-1 BFS computing the shortest link-distance from the start anime to
 *  every reachable node. `maxLinks` prunes exploration past that bound
 *  (so a goal whose true optimum exceeds it stays unreached). */
function computeShortestDistances(
  adjacency: CachedAdjacency,
  startMediaId: number,
  maxLinks: number | undefined,
): Map<string, number> {
  const limit = maxLinks ?? Number.POSITIVE_INFINITY;
  const dist = new Map<string, number>();
  const startKey = nodeKey('anime', startMediaId);
  dist.set(startKey, 0);
  const deque: { node: GraphNode; d: number }[] = [
    { node: { kind: 'anime', id: startMediaId }, d: 0 },
  ];

  while (deque.length > 0) {
    const { node, d } = deque.shift()!;
    const best = dist.get(nodeKey(node.kind, node.id));
    if (best !== undefined && d > best) {
      continue; // stale deque entry superseded by a shorter relaxation
    }
    for (const { node: nbr, weight } of neighborsOf(adjacency, node)) {
      const nd = d + weight;
      if (nd > limit) {
        continue;
      }
      const nbrKey = nodeKey(nbr.kind, nbr.id);
      const prev = dist.get(nbrKey);
      if (prev === undefined || nd < prev) {
        dist.set(nbrKey, nd);
        if (weight === 0) {
          deque.unshift({ node: nbr, d: nd });
        } else {
          deque.push({ node: nbr, d: nd });
        }
      }
    }
  }
  return dist;
}

/** Shortest-path predecessor DAG: parent `u` is kept for child `v` when
 *  the edge `u→v` lies on some shortest path (`dist[u] + w == dist[v]`). */
function buildShortestPathPredecessors(
  adjacency: CachedAdjacency,
  dist: Map<string, number>,
): Map<string, GraphNode[]> {
  const preds = new Map<string, GraphNode[]>();
  const consider = (from: GraphNode, to: GraphNode, weight: number): void => {
    const fromDist = dist.get(nodeKey(from.kind, from.id));
    const toKey = nodeKey(to.kind, to.id);
    const toDist = dist.get(toKey);
    if (fromDist === undefined || toDist === undefined) {
      return;
    }
    if (fromDist + weight === toDist) {
      let list = preds.get(toKey);
      if (!list) {
        list = [];
        preds.set(toKey, list);
      }
      list.push(from);
    }
  };

  for (const [mediaId, staffSet] of adjacency.animeToStaff) {
    for (const staffId of staffSet) {
      consider({ kind: 'anime', id: mediaId }, { kind: 'staff', id: staffId }, 0);
    }
  }
  for (const [staffId, animeSet] of adjacency.staffToAnime) {
    for (const mediaId of animeSet) {
      consider({ kind: 'staff', id: staffId }, { kind: 'anime', id: mediaId }, 1);
    }
  }
  for (const [fromId, toSet] of adjacency.animeToAnime) {
    for (const toId of toSet) {
      consider({ kind: 'anime', id: fromId }, { kind: 'anime', id: toId }, 1);
    }
  }
  return preds;
}

/** Backward DFS over the predecessor DAG, lazily yielding each distinct
 *  shortest path as a start→goal ordered node array. The DAG is acyclic
 *  (predecessors have strictly smaller rank), so enumeration terminates. */
function* enumerateShortestPaths(
  preds: Map<string, GraphNode[]>,
  startMediaId: number,
  goal: GraphNode,
): Generator<GraphNode[]> {
  const startKey = nodeKey('anime', startMediaId);

  function* walk(node: GraphNode): Generator<GraphNode[]> {
    const key = nodeKey(node.kind, node.id);
    if (key === startKey) {
      yield [node];
      return;
    }
    const parents = preds.get(key);
    if (!parents) {
      return;
    }
    for (const parent of parents) {
      for (const sub of walk(parent)) {
        yield [...sub, node];
      }
    }
  }

  yield* walk(goal);
}

/**
 * Build a stream that enumerates every distinct shortest path between
 * the endpoints in the cached graph. The expensive work (adjacency load,
 * BFS, predecessor DAG) happens once here; each `stream.next()` only
 * pulls + hydrates the next path, so multi-click browsing stays cheap.
 */
export async function buildCachedShortestPathStream(
  params: FindCachedOptimalPathParams,
): Promise<BuildCachedShortestPathStream> {
  const { db, startMediaId, goalMediaId, rules, maxLinks } = params;

  if (startMediaId === goalMediaId) {
    return { status: 'same' };
  }
  if (maxLinks !== undefined && maxLinks <= 0) {
    return { status: 'not_found' };
  }

  const adjacency = await loadCachedAdjacency(db, rules);
  const dist = computeShortestDistances(adjacency, startMediaId, maxLinks);
  const optimalLinks = dist.get(nodeKey('anime', goalMediaId));
  if (optimalLinks === undefined) {
    return { status: 'not_found' };
  }

  const preds = buildShortestPathPredecessors(adjacency, dist);
  const iterator = enumerateShortestPaths(preds, startMediaId, {
    kind: 'anime',
    id: goalMediaId,
  });
  let yielded = 0;

  const stream: CachedShortestPathStream = {
    optimalLinks,
    async next() {
      const result = iterator.next();
      if (result.done) {
        return { status: 'exhausted', total: yielded };
      }
      const steps = await hydratePathSteps(db, result.value, rules);
      yielded += 1;
      return { status: 'found', linksUsed: optimalLinks, steps };
    },
  };

  return { status: 'ready', stream };
}

export async function findCachedOptimalPath(
  params: FindCachedOptimalPathParams,
): Promise<CachedOptimalPathResult> {
  const { db, startMediaId, goalMediaId, rules, maxLinks } = params;

  if (startMediaId === goalMediaId) {
    return { status: 'same' };
  }

  if (maxLinks !== undefined && maxLinks <= 0) {
    return { status: 'not_found' };
  }

  const direct = await tryDirectOneLinkPath(db, startMediaId, goalMediaId, rules);
  if (direct) {
    return direct;
  }

  const adjacency = await loadCachedAdjacency(db, rules);
  const pathNodes = runZeroOneBfs(adjacency, startMediaId, goalMediaId, maxLinks);
  if (!pathNodes) {
    return { status: 'not_found' };
  }

  const linksUsed = pathNodes.filter((node) => node.kind === 'anime').length - 1;
  const steps = await hydratePathSteps(db, pathNodes, rules);
  return { status: 'found', linksUsed, steps };
}
