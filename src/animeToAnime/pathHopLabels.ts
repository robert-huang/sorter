import type {
  AnimeFilmographyRow,
  ProductionCreditRow,
} from '../lib/importers/anilist/graphQueries';
import type { AnilistDbExecutor } from '../lib/importers/anilist/context';
import {
  getAnimeFilmographyForStaff,
  getProductionCreditsAtMedia,
  getVaCreditsAtMedia,
} from '../lib/importers/anilist/graphQueries';
import type { RoundConfig } from './preferences';
import type { PathStep } from './pathHistory';
import {
  filmographyRolesSubtitle,
  groupSortedVaCredits,
  groupedVaCreditSubtitle,
  type GroupedVaCreditRow,
} from './vaCreditDisplay';

type GraphNode = { kind: 'anime' | 'staff'; id: number };

export function viaLabelFromVaGroup(group: GroupedVaCreditRow): string {
  return groupedVaCreditSubtitle(group) ?? 'Voice actor';
}

export function viaLabelFromProduction(row: ProductionCreditRow): string {
  return row.roles.length > 0 ? row.roles.join(', ') : 'Production';
}

export function viaLabelFromFilmography(row: AnimeFilmographyRow): string {
  return filmographyRolesSubtitle(row) ?? (row.creditKind === 'voice' ? 'Voice actor' : 'Production');
}

export function viaLabelFromRelation(relationType: string): string {
  return relationType;
}

function productionRoleMode(rules: RoundConfig): 'key' | 'all' {
  return rules.productionAllRoles ? 'all' : 'key';
}

async function resolveAnimeToStaffViaLabel(
  db: AnilistDbExecutor,
  mediaId: number,
  staffId: number,
  rules: RoundConfig,
): Promise<string | null> {
  const vaRows = await getVaCreditsAtMedia(db, mediaId);
  const vaGroup = groupSortedVaCredits(vaRows).find((group) => group.staff.id === staffId);
  if (vaGroup) {
    return viaLabelFromVaGroup(vaGroup);
  }

  if (!rules.allowProduction) {
    return null;
  }

  const prodRows = await getProductionCreditsAtMedia(
    db,
    mediaId,
    productionRoleMode(rules),
  );
  const prodRow = prodRows.find((row) => row.staff.id === staffId);
  return prodRow ? viaLabelFromProduction(prodRow) : null;
}

async function resolveStaffToAnimeViaLabel(
  db: AnilistDbExecutor,
  staffId: number,
  mediaId: number,
  rules: RoundConfig,
): Promise<string | null> {
  const filmography = await getAnimeFilmographyForStaff(
    db,
    staffId,
    productionRoleMode(rules),
  );
  const voiceRow = filmography.find(
    (row) => row.media.id === mediaId && row.creditKind === 'voice',
  );
  if (voiceRow) {
    return viaLabelFromFilmography(voiceRow);
  }

  const productionRow = filmography.find(
    (row) => row.media.id === mediaId && row.creditKind === 'production',
  );
  return productionRow ? viaLabelFromFilmography(productionRow) : null;
}

async function resolveAnimeToAnimeViaLabel(
  db: AnilistDbExecutor,
  fromMediaId: number,
  toMediaId: number,
): Promise<string | null> {
  const rows = await db.exec(
    `
      SELECT relation_type
      FROM media_relation
      WHERE (from_media_id = ? AND to_media_id = ?)
         OR (from_media_id = ? AND to_media_id = ?)
      LIMIT 1
    `,
    [fromMediaId, toMediaId, toMediaId, fromMediaId],
  );
  if (rows.length === 0) {
    return null;
  }
  return viaLabelFromRelation(String(rows[0].relation_type));
}

async function resolveHopViaLabel(
  db: AnilistDbExecutor,
  from: GraphNode,
  to: GraphNode,
  rules: RoundConfig,
): Promise<string | null> {
  if (from.kind === 'anime' && to.kind === 'staff') {
    return resolveAnimeToStaffViaLabel(db, from.id, to.id, rules);
  }
  if (from.kind === 'staff' && to.kind === 'anime') {
    return resolveStaffToAnimeViaLabel(db, from.id, to.id, rules);
  }
  if (from.kind === 'anime' && to.kind === 'anime') {
    return resolveAnimeToAnimeViaLabel(db, from.id, to.id);
  }
  return null;
}

/** Fill `viaLabel` on each step after the first — used for cached optimal paths. */
export async function annotatePathViaLabels(
  db: AnilistDbExecutor,
  nodes: readonly GraphNode[],
  steps: readonly PathStep[],
  rules: RoundConfig,
): Promise<PathStep[]> {
  if (nodes.length !== steps.length) {
    throw new Error('annotatePathViaLabels: nodes/steps length mismatch');
  }

  const annotated: PathStep[] = steps.map((step) => ({ ...step }));
  for (let index = 1; index < nodes.length; index += 1) {
    const viaLabel = await resolveHopViaLabel(db, nodes[index - 1], nodes[index], rules);
    if (!viaLabel) {
      continue;
    }
    annotated[index] = { ...annotated[index], viaLabel };
  }
  return annotated;
}
