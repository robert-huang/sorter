/**
 * In-memory 0-1 BFS over cached AniList SQLite adjacency for optimal path lookup.
 */

import type { AnilistDbExecutor } from '../lib/importers/anilist/context';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { pickPersonName } from '../lib/importers/anilist/personDisplayLabel';
import { filterProductionStaffRows } from '../lib/importers/anilist/staffRoleFilter';
import { matchesStaffGender, type RoundConfig, type StaffGenderFilter } from './preferences';
import type { PathHopCharacter, PathStep } from './pathHistory';
import { annotatePathViaLabels } from './pathHopLabels';

/** A path step known to be an anime node (slots only ever hold anime). */
type AnimeStep = Extract<PathStep, { kind: 'anime' }>;

export type FindCachedOptimalPathParams = {
  db: AnilistDbExecutor;
  startMediaId: number;
  goalMediaId: number;
  rules: RoundConfig;
  /** When set, BFS stops expanding past this link count. Omit for unbounded search. */
  maxLinks?: number;
  /**
   * Live gender filter: only staff matching it may bridge two anime. Defaults
   * to `'any'` (no filtering). Missing/unknown and non-binary gender are
   * excluded under `'male'`/`'female'`.
   */
  genderFilter?: StaffGenderFilter;
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

/**
 * Set of staff ids passing the gender filter, or `null` when no filtering is
 * needed (`'any'`). Built once per adjacency load so each staff node is gated
 * with an O(1) lookup.
 */
async function loadGenderAllowedStaffIds(
  db: AnilistDbExecutor,
  genderFilter: StaffGenderFilter,
): Promise<Set<number> | null> {
  if (genderFilter === 'any') {
    return null;
  }
  const rows = await db.exec('SELECT id, gender FROM staff');
  const allowed = new Set<number>();
  for (const row of rows) {
    const gender = row.gender === null || row.gender === undefined ? null : String(row.gender);
    if (matchesStaffGender(gender, genderFilter)) {
      allowed.add(Number(row.id));
    }
  }
  return allowed;
}

async function loadCachedAdjacency(
  db: AnilistDbExecutor,
  rules: RoundConfig,
  genderFilter: StaffGenderFilter = 'any',
): Promise<CachedAdjacency> {
  const roleMode = productionRoleMode(rules);
  const animeToStaff = new Map<number, Set<number>>();
  const staffToAnime = new Map<number, Set<number>>();
  const animeToAnime = new Map<number, Set<number>>();

  // When a gender filter is active, drop any staff that doesn't match so they
  // can never be a node on a path. `null` means no filtering ('any').
  const allowedStaff = await loadGenderAllowedStaffIds(db, genderFilter);
  const isStaffAllowed = (staffId: number): boolean =>
    allowedStaff === null || allowedStaff.has(staffId);

  const cvaRows = await db.exec(`
    SELECT cva.media_id, cva.staff_id
    FROM character_voice_actor cva
    JOIN media m ON m.id = cva.media_id AND m.type = 'ANIME'
  `);

  for (const row of cvaRows) {
    const mediaId = Number(row.media_id);
    const staffId = Number(row.staff_id);
    if (!isStaffAllowed(staffId)) {
      continue;
    }
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
    if (!isStaffAllowed(row.staffId)) {
      continue;
    }
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
  genderFilter: StaffGenderFilter = 'any',
): Promise<number | null> {
  // LEFT JOIN so 'any' keeps the original behavior even if a staff row is
  // missing; the gender match is applied in JS via the shared helper.
  const rows = await db.exec(
    `
      SELECT cva1.staff_id AS staff_id, st.gender AS gender
      FROM character_voice_actor cva1
      JOIN character_voice_actor cva2 ON cva1.staff_id = cva2.staff_id
      LEFT JOIN staff st ON st.id = cva1.staff_id
      WHERE cva1.media_id = ? AND cva2.media_id = ?
    `,
    [startMediaId, goalMediaId],
  );
  for (const row of rows) {
    const gender = row.gender === null || row.gender === undefined ? null : String(row.gender);
    if (matchesStaffGender(gender, genderFilter)) {
      return Number(row.staff_id);
    }
  }
  return null;
}

async function findSharedProductionStaff(
  db: AnilistDbExecutor,
  startMediaId: number,
  goalMediaId: number,
  rules: RoundConfig,
  genderFilter: StaffGenderFilter = 'any',
): Promise<number | null> {
  if (!rules.allowProduction) {
    return null;
  }

  const rows = await db.exec(
    `
      SELECT ms1.staff_id AS staff_id, ms1.role AS role, st.gender AS gender
      FROM media_staff ms1
      JOIN media_staff ms2 ON ms1.staff_id = ms2.staff_id
      LEFT JOIN staff st ON st.id = ms1.staff_id
      WHERE ms1.media_id = ? AND ms2.media_id = ?
    `,
    [startMediaId, goalMediaId],
  );

  const genderByStaffId = new Map<number, string | null>();
  for (const row of rows) {
    genderByStaffId.set(
      Number(row.staff_id),
      row.gender === null || row.gender === undefined ? null : String(row.gender),
    );
  }

  const roleMode = productionRoleMode(rules);
  const filtered = filterProductionStaffRows(
    rows.map((row) => ({
      staffId: Number(row.staff_id),
      role: row.role === null || row.role === undefined ? null : String(row.role),
    })),
    roleMode,
  );

  for (const row of filtered) {
    if (matchesStaffGender(genderByStaffId.get(row.staffId) ?? null, genderFilter)) {
      return row.staffId;
    }
  }
  return null;
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
  genderFilter: StaffGenderFilter = 'any',
): Promise<CachedOptimalPathResult | null> {
  if (await hasDirectFranchiseLink(db, startMediaId, goalMediaId, rules)) {
    const steps = await buildOneLinkPath(db, startMediaId, goalMediaId, null, rules);
    return { status: 'found', linksUsed: 1, steps };
  }

  const sharedVa = await findSharedVaStaff(db, startMediaId, goalMediaId, genderFilter);
  if (sharedVa !== null) {
    const steps = await buildOneLinkPath(db, startMediaId, goalMediaId, sharedVa, rules);
    return { status: 'found', linksUsed: 1, steps };
  }

  const sharedProd = await findSharedProductionStaff(
    db,
    startMediaId,
    goalMediaId,
    rules,
    genderFilter,
  );
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
  const { db, startMediaId, goalMediaId, rules, maxLinks, genderFilter = 'any' } = params;

  if (startMediaId === goalMediaId) {
    return { status: 'same' };
  }
  if (maxLinks !== undefined && maxLinks <= 0) {
    return { status: 'not_found' };
  }

  const adjacency = await loadCachedAdjacency(db, rules, genderFilter);
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

// ---------------------------------------------------------------------------
// Collapsed routes: group shortest paths by their staff skeleton, with each
// intermediate show held as a selectable "slot".
// ---------------------------------------------------------------------------

/** One element of a route skeleton (start→goal order), before hydration.
 *  Fixed nodes (start, goal, staff, relation-anime) pin the staff sequence;
 *  a slot is the set of interchangeable intermediate shows between two staff. */
type RouteSkeletonItem =
  | { kind: 'fixed'; node: GraphNode }
  | { kind: 'slot'; animeIds: number[] };

type RouteSkeleton = { items: RouteSkeletonItem[] };

function skeletonKey(items: readonly RouteSkeletonItem[]): string {
  return items
    .map((item) =>
      item.kind === 'fixed'
        ? `${item.node.kind}:${item.node.id}`
        : `slot[${item.animeIds.join('.')}]`,
    )
    .join('>');
}

/**
 * Lazily enumerate distinct route skeletons over the shortest-path predecessor
 * DAG. Branches only on staff (and relation-anime fixed nodes); the
 * intermediate shows between two consecutive staff are collected into a slot
 * set rather than multiplied out, so a route compactly represents the whole
 * product of slot choices without the cartesian blowup.
 *
 * The DAG is acyclic (predecessors have strictly smaller shortest distance),
 * so both nested walks terminate.
 */
function* enumerateStaffRoutes(
  preds: Map<string, GraphNode[]>,
  startMediaId: number,
  goal: GraphNode,
): Generator<RouteSkeleton> {
  /** Skeleton prefixes for start→…→(the node immediately before `sNext`),
   *  i.e. ending at the slot that feeds `sNext` (or at `start` when `sNext`
   *  sits directly on the start anime). `sNext` itself is appended by the
   *  caller. */
  function* enumToStaff(sNext: GraphNode): Generator<RouteSkeletonItem[]> {
    const animePreds = preds.get(nodeKey('staff', sNext.id)) ?? [];
    let startsDirectly = false;
    // Group slot candidates by the staff two hops back: slot(sPrev, sNext) is
    // every show featuring both flanking staff.
    const slotsByPrevStaff = new Map<number, Set<number>>();
    const relationShows: GraphNode[] = [];

    for (const show of animePreds) {
      if (show.kind !== 'anime') {
        continue;
      }
      if (show.id === startMediaId) {
        startsDirectly = true;
        continue;
      }
      const showPreds = preds.get(nodeKey('anime', show.id)) ?? [];
      for (const prev of showPreds) {
        if (prev.kind === 'staff') {
          let set = slotsByPrevStaff.get(prev.id);
          if (!set) {
            set = new Set();
            slotsByPrevStaff.set(prev.id, set);
          }
          set.add(show.id);
        }
      }
      if (showPreds.some((prev) => prev.kind === 'anime')) {
        relationShows.push(show);
      }
    }

    if (startsDirectly) {
      yield [{ kind: 'fixed', node: { kind: 'anime', id: startMediaId } }];
    }
    for (const [prevStaffId, shows] of slotsByPrevStaff) {
      const animeIds = [...shows].sort((a, b) => a - b);
      for (const prefix of enumToStaff({ kind: 'staff', id: prevStaffId })) {
        yield [
          ...prefix,
          { kind: 'fixed', node: { kind: 'staff', id: prevStaffId } },
          { kind: 'slot', animeIds },
        ];
      }
    }
    // A show reached via a relation edge is a fixed node, not a collapsible
    // slot — emit the full start→show prefix as-is (it ends with fixed(show)).
    for (const show of relationShows) {
      yield* enumToAnime(show);
    }
  }

  /** Skeletons for start→`a`, ending with `fixed(a)`. */
  function* enumToAnime(a: GraphNode): Generator<RouteSkeletonItem[]> {
    if (a.kind === 'anime' && a.id === startMediaId) {
      yield [{ kind: 'fixed', node: { kind: 'anime', id: startMediaId } }];
      return;
    }
    const incoming = preds.get(nodeKey(a.kind, a.id)) ?? [];
    for (const prev of incoming) {
      if (prev.kind === 'staff') {
        for (const prefix of enumToStaff(prev)) {
          yield [...prefix, { kind: 'fixed', node: prev }, { kind: 'fixed', node: a }];
        }
      } else {
        // Relation edge prev(anime)→a: the edge is implied by adjacency of two
        // fixed anime items in the hydrated trail.
        for (const prefix of enumToAnime(prev)) {
          yield [...prefix, { kind: 'fixed', node: a }];
        }
      }
    }
  }

  const seen = new Set<string>();
  for (const items of enumToAnime(goal)) {
    const key = skeletonKey(items);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    yield { items };
  }
}

/** A selectable show in a slot, carrying both of its incident edge labels. */
export type RouteSlotOption = {
  /** The show, annotated with the `sPrev→show` edge (its incoming arrow). */
  show: AnimeStep;
  /** The `show→sNext` edge — overrides the following staff's incoming arrow. */
  nextStaffVia: { viaLabel?: string; viaCharacters?: readonly PathHopCharacter[] };
};

/** One position in a collapsed route: a pinned node or a selectable slot. */
export type RouteItem =
  | { kind: 'fixed'; step: PathStep }
  | { kind: 'slot'; options: RouteSlotOption[] };

/** A shortest route grouped by staff skeleton; slots hold the show choices. */
export type CollapsedRoute = {
  linksUsed: number;
  items: RouteItem[];
};

type StaffVia = { viaLabel?: string; viaCharacters?: readonly PathHopCharacter[] };

function viaOf(step: PathStep): StaffVia {
  return { viaLabel: step.viaLabel, viaCharacters: step.viaCharacters };
}

/** Resolve a single hop's edge label, returning the annotated `to` step. */
async function resolveEdgeStep(
  db: AnilistDbExecutor,
  fromNode: GraphNode,
  fromStep: PathStep,
  toNode: GraphNode,
  toStep: PathStep,
  rules: RoundConfig,
): Promise<PathStep> {
  const annotated = await annotatePathViaLabels(
    db,
    [fromNode, toNode],
    [fromStep, toStep],
    rules,
  );
  return annotated[1];
}

/**
 * Hydrate a route skeleton into a {@link CollapsedRoute}: batch the base node
 * details once, then derive each edge label. Fixed-spine edges (start→s1,
 * sL→goal, relation pairs) are resolved on adjacent fixed nodes; slot edges
 * are resolved per option. Single-option slots collapse to fixed nodes so
 * simple routes render plainly.
 */
async function hydrateRouteSkeleton(
  db: AnilistDbExecutor,
  skeleton: RouteSkeleton,
  rules: RoundConfig,
  linksUsed: number,
): Promise<CollapsedRoute> {
  const { items } = skeleton;

  const nodeByKey = new Map<string, GraphNode>();
  for (const item of items) {
    if (item.kind === 'fixed') {
      nodeByKey.set(nodeKey(item.node.kind, item.node.id), item.node);
    } else {
      for (const id of item.animeIds) {
        nodeByKey.set(nodeKey('anime', id), { kind: 'anime', id });
      }
    }
  }
  const uniqueNodes = [...nodeByKey.values()];
  const baseSteps = await hydratePathSteps(db, uniqueNodes);
  const baseByKey = new Map<string, PathStep>();
  uniqueNodes.forEach((node, index) => {
    baseByKey.set(nodeKey(node.kind, node.id), baseSteps[index]);
  });
  const baseOf = (node: GraphNode): PathStep => {
    const step = baseByKey.get(nodeKey(node.kind, node.id));
    return step ? { ...step } : { ...baseSteps[0] };
  };

  const result: RouteItem[] = [];
  // When a single-option slot collapses to a fixed show, its `show→sNext`
  // edge must still flow onto the following (now fixed) staff item.
  let carriedStaffVia: StaffVia | null = null;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const prev = items[i - 1];

    if (item.kind === 'fixed') {
      const step = baseOf(item.node);
      if (i === 0) {
        // start node — no incoming edge.
      } else if (prev.kind === 'fixed') {
        const annotated = await resolveEdgeStep(
          db,
          prev.node,
          baseOf(prev.node),
          item.node,
          step,
          rules,
        );
        result.push({ kind: 'fixed', step: annotated });
        continue;
      } else if (carriedStaffVia) {
        // Previous item was a collapsed single-option slot.
        step.viaLabel = carriedStaffVia.viaLabel;
        step.viaCharacters = carriedStaffVia.viaCharacters;
        carriedStaffVia = null;
      } else {
        // Previous item is a multi-option slot: default to its first option's
        // outgoing edge; the trail UI overrides this on selection.
        const prevResult = result[result.length - 1];
        if (prevResult?.kind === 'slot') {
          const via = prevResult.options[0].nextStaffVia;
          step.viaLabel = via.viaLabel;
          step.viaCharacters = via.viaCharacters;
        }
      }
      result.push({ kind: 'fixed', step });
      continue;
    }

    // Slot: flanked by fixed staff on both sides (enumeration guarantees it).
    const sPrev = (prev as { kind: 'fixed'; node: GraphNode }).node;
    const sNext = (items[i + 1] as { kind: 'fixed'; node: GraphNode }).node;
    const options: RouteSlotOption[] = [];
    for (const id of item.animeIds) {
      const showNode: GraphNode = { kind: 'anime', id };
      const showStep = await resolveEdgeStep(
        db,
        sPrev,
        baseOf(sPrev),
        showNode,
        baseOf(showNode),
        rules,
      );
      const staffViaStep = await resolveEdgeStep(
        db,
        showNode,
        baseOf(showNode),
        sNext,
        baseOf(sNext),
        rules,
      );
      if (showStep.kind !== 'anime') {
        continue;
      }
      options.push({ show: showStep, nextStaffVia: viaOf(staffViaStep) });
    }
    options.sort((a, b) => a.show.title.localeCompare(b.show.title));

    if (options.length === 1) {
      result.push({ kind: 'fixed', step: options[0].show });
      carriedStaffVia = options[0].nextStaffVia;
    } else {
      result.push({ kind: 'slot', options });
    }
  }

  return { linksUsed, items: result };
}

/** One pull from a {@link CachedRouteStream}. */
export type CachedRouteStreamResult =
  | { status: 'found'; route: CollapsedRoute }
  | { status: 'exhausted'; total: number };

/**
 * Lazily yields every distinct collapsed route (grouped by staff skeleton),
 * one per `next()` call. Mirrors {@link CachedShortestPathStream}, but each
 * yield is a route whose intermediate shows are selectable slots.
 */
export type CachedRouteStream = {
  optimalLinks: number;
  next: () => Promise<CachedRouteStreamResult>;
};

export type BuildCachedRouteStream =
  | { status: 'ready'; stream: CachedRouteStream }
  | { status: 'not_found' }
  | { status: 'same' };

/**
 * Build a stream that enumerates every distinct collapsed route between the
 * endpoints in the cached graph. The expensive adjacency/BFS/DAG work happens
 * once; each `stream.next()` pulls + hydrates the next route's skeleton.
 */
export async function buildCachedRouteStream(
  params: FindCachedOptimalPathParams,
): Promise<BuildCachedRouteStream> {
  const { db, startMediaId, goalMediaId, rules, maxLinks, genderFilter = 'any' } = params;

  if (startMediaId === goalMediaId) {
    return { status: 'same' };
  }
  if (maxLinks !== undefined && maxLinks <= 0) {
    return { status: 'not_found' };
  }

  const adjacency = await loadCachedAdjacency(db, rules, genderFilter);
  const dist = computeShortestDistances(adjacency, startMediaId, maxLinks);
  const optimalLinks = dist.get(nodeKey('anime', goalMediaId));
  if (optimalLinks === undefined) {
    return { status: 'not_found' };
  }

  const preds = buildShortestPathPredecessors(adjacency, dist);
  const iterator = enumerateStaffRoutes(preds, startMediaId, {
    kind: 'anime',
    id: goalMediaId,
  });
  let yielded = 0;

  const stream: CachedRouteStream = {
    optimalLinks,
    async next() {
      const result = iterator.next();
      if (result.done) {
        return { status: 'exhausted', total: yielded };
      }
      const route = await hydrateRouteSkeleton(db, result.value, rules, optimalLinks);
      yielded += 1;
      return { status: 'found', route };
    },
  };

  return { status: 'ready', stream };
}

export async function findCachedOptimalPath(
  params: FindCachedOptimalPathParams,
): Promise<CachedOptimalPathResult> {
  const { db, startMediaId, goalMediaId, rules, maxLinks, genderFilter = 'any' } = params;

  if (startMediaId === goalMediaId) {
    return { status: 'same' };
  }

  if (maxLinks !== undefined && maxLinks <= 0) {
    return { status: 'not_found' };
  }

  const direct = await tryDirectOneLinkPath(db, startMediaId, goalMediaId, rules, genderFilter);
  if (direct) {
    return direct;
  }

  const adjacency = await loadCachedAdjacency(db, rules, genderFilter);
  const pathNodes = runZeroOneBfs(adjacency, startMediaId, goalMediaId, maxLinks);
  if (!pathNodes) {
    return { status: 'not_found' };
  }

  const linksUsed = pathNodes.filter((node) => node.kind === 'anime').length - 1;
  const steps = await hydratePathSteps(db, pathNodes, rules);
  return { status: 'found', linksUsed, steps };
}
