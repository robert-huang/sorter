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
import type { PathHopCharacter, PathStep } from './pathHistory';
import {
  filmographyRolesSubtitle,
  groupSortedVaCredits,
  groupedVaCreditSubtitle,
  vaCreditCharacterName,
  type GroupedVaCreditRow,
} from './vaCreditDisplay';

type GraphNode = { kind: 'anime' | 'staff'; id: number };

/** Resolved hop edge: its tooltip label plus any VA characters it passed through. */
type HopResolution = {
  label: string;
  characters?: PathHopCharacter[];
};

export function viaLabelFromVaGroup(group: GroupedVaCreditRow): string {
  return groupedVaCreditSubtitle(group) ?? 'Voice actor';
}

/** Distinct characters a voice actor voiced in one show (for the arrow link). */
export function charactersFromVaGroup(group: GroupedVaCreditRow): PathHopCharacter[] {
  const seen = new Set<number>();
  const characters: PathHopCharacter[] = [];
  for (const credit of group.credits) {
    if (seen.has(credit.character.id)) {
      continue;
    }
    seen.add(credit.character.id);
    characters.push({ id: credit.character.id, name: vaCreditCharacterName(credit) });
  }
  return characters;
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
): Promise<HopResolution | null> {
  const vaRows = await getVaCreditsAtMedia(db, mediaId);
  const vaGroup = groupSortedVaCredits(vaRows).find((group) => group.staff.id === staffId);
  if (vaGroup) {
    return { label: viaLabelFromVaGroup(vaGroup), characters: charactersFromVaGroup(vaGroup) };
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
  return prodRow ? { label: viaLabelFromProduction(prodRow) } : null;
}

async function resolveStaffToAnimeViaLabel(
  db: AnilistDbExecutor,
  staffId: number,
  mediaId: number,
  rules: RoundConfig,
): Promise<HopResolution | null> {
  const filmography = await getAnimeFilmographyForStaff(
    db,
    staffId,
    productionRoleMode(rules),
  );
  const voiceRow = filmography.find(
    (row) => row.media.id === mediaId && row.creditKind === 'voice',
  );
  if (voiceRow) {
    // Filmography rows carry character *names* only; resolve the VA group at
    // the target media to capture character ids for the arrow's middle-click.
    const vaRows = await getVaCreditsAtMedia(db, mediaId);
    const vaGroup = groupSortedVaCredits(vaRows).find((group) => group.staff.id === staffId);
    return {
      label: viaLabelFromFilmography(voiceRow),
      ...(vaGroup ? { characters: charactersFromVaGroup(vaGroup) } : {}),
    };
  }

  const productionRow = filmography.find(
    (row) => row.media.id === mediaId && row.creditKind === 'production',
  );
  return productionRow ? { label: viaLabelFromFilmography(productionRow) } : null;
}

async function resolveAnimeToAnimeViaLabel(
  db: AnilistDbExecutor,
  fromMediaId: number,
  toMediaId: number,
): Promise<HopResolution | null> {
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
  return { label: viaLabelFromRelation(String(rows[0].relation_type)) };
}

async function resolveHopViaLabel(
  db: AnilistDbExecutor,
  from: GraphNode,
  to: GraphNode,
  rules: RoundConfig,
): Promise<HopResolution | null> {
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

/**
 * Fill `viaLabel` (and, for voice hops, `viaCharacters`) on each step after
 * the first — used for cached optimal paths.
 */
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
    const resolution = await resolveHopViaLabel(db, nodes[index - 1], nodes[index], rules);
    if (!resolution) {
      continue;
    }
    annotated[index] = {
      ...annotated[index],
      viaLabel: resolution.label,
      ...(resolution.characters && resolution.characters.length > 0
        ? { viaCharacters: resolution.characters }
        : {}),
    };
  }
  return annotated;
}
