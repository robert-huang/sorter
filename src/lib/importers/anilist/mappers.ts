/**
 * Pure GraphQL → SQLite row mappers. Every function takes a (validated)
 * GraphQL node shape and returns the data tuple ready to be `INSERT`ed
 * via positional bind.
 *
 * Defensive about nullability: AniList's schema allows nulls in places
 * that "shouldn't" be null (e.g. `coverImage`, `studios`, `genres`). The
 * mapper layer collapses those nulls to safe SQL values (`null` for
 * scalars, `'[]'` for the genres-json string when source was null).
 */

import type {
  AnilistCharacterGql,
  AnilistCharacterRole,
  AnilistFavouriteEdge,
  AnilistFavouriteStudioNode,
  AnilistFuzzyDate,
  AnilistMediaCharacterEdgeGql,
  AnilistMediaStaffEdgeGql,
  AnilistMediaGql,
  AnilistMediaListEntryGql,
  AnilistStaffGql,
  AnilistStaffLanguage,
  AnilistUserResolveResponse,
  AnilistUserRow,
  CharacterFavouriteRow,
  CharacterRow,
  CharacterVoiceActorRow,
  MediaCharacterRow,
  MediaStaffRow,
  MediaFavouriteRow,
  MediaListEntryRow,
  MediaRow,
  MediaStudioRow,
  MediaTagRow,
  StaffFavouriteRow,
  StaffRow,
  StudioFavouriteRow,
  StudioRow,
  TagRow,
} from './types';

/**
 * Destructure an AniList FuzzyDate into three nullable INTEGER components.
 * The wrapper itself may be null (date absent), in which case every part
 * is null.
 */
function fuzzyDateParts(
  date: AnilistFuzzyDate | null,
): { year: number | null; month: number | null; day: number | null } {
  if (!date) {
    return { year: null, month: null, day: null };
  }
  return { year: date.year ?? null, month: date.month ?? null, day: date.day ?? null };
}

/**
 * Serialize the `genres` array. AniList typically returns `[]` for "no
 * genres" but the field is nullable, so we coerce both `null` and missing
 * to `[]` so the column is queryable as JSON unconditionally.
 */
function genresJson(genres: string[] | null): string {
  return JSON.stringify(genres ?? []);
}

/**
 * Serialize an array-of-strings JSON column (synonyms, name
 * alternatives). Distinct from genresJson: a missing/null AniList
 * value is preserved as `null` rather than coerced to `'[]'`, since
 * for these columns "AniList didn't return any" is genuinely
 * meaningful (no aliases vs empty-array-of-aliases is the same data,
 * but null is cheaper to detect with `IS NULL` filters).
 */
function stringArrayJson(values: string[] | null | undefined): string | null {
  if (!values || values.length === 0) {
    return null;
  }
  return JSON.stringify(values);
}

/**
 * Map AniList's `User(name:)` resolution result into a row for the
 * `anilist_user` table. Importer is expected to short-circuit BEFORE
 * calling this if `gql.User === null` (unknown username is a hard
 * error), so this helper assumes the field is populated.
 */
export function mapAnilistUserRow(
  gql: NonNullable<AnilistUserResolveResponse['User']>,
  now: number,
): AnilistUserRow {
  return {
    id: gql.id,
    name: gql.name,
    fetched_at: now,
    updated_at: now,
  };
}

export function mapMediaRow(media: AnilistMediaGql, now: number): MediaRow {
  const start = fuzzyDateParts(media.startDate ?? null);
  const end = fuzzyDateParts(media.endDate ?? null);
  return {
    id: media.id,
    type: media.type,
    title_english: media.title.english ?? null,
    title_romaji: media.title.romaji ?? null,
    title_native: media.title.native ?? null,
    cover_image: media.coverImage?.large ?? null,
    format: media.format ?? null,
    source: media.source ?? null,
    status: media.status ?? null,
    episodes: media.episodes ?? null,
    chapters: media.chapters ?? null,
    start_year: start.year,
    start_month: start.month,
    start_day: start.day,
    end_year: end.year,
    end_month: end.month,
    end_day: end.day,
    season: media.season ?? null,
    season_year: media.seasonYear ?? null,
    mean_score: media.meanScore ?? null,
    favourites: media.favourites ?? null,
    country_of_origin: media.countryOfOrigin ?? null,
    genres_json: genresJson(media.genres ?? null),
    synonyms_json: stringArrayJson(media.synonyms),
    fetched_at: now,
    updated_at: now,
  };
}

/** Partial media row from `TOOLS_CHARACTER_VOICE_MEDIA_QUERY` — no `source`. */
export function mapMediaStubRow(media: AnilistMediaGql, now: number): {
  id: number;
  type: MediaRow['type'];
  title_english: string | null;
  title_romaji: string | null;
  title_native: string | null;
  cover_image: string | null;
  format: MediaRow['format'];
  synonyms_json: string | null;
  fetched_at: number;
  updated_at: number;
} {
  return {
    id: media.id,
    type: media.type,
    title_english: media.title.english ?? null,
    title_romaji: media.title.romaji ?? null,
    title_native: media.title.native ?? null,
    cover_image: media.coverImage?.large ?? null,
    format: media.format ?? null,
    synonyms_json: stringArrayJson(media.synonyms),
    fetched_at: now,
    updated_at: now,
  };
}

/**
 * Returns one StudioRow per unique studio referenced by the media.
 *
 * AniList's `studios.nodes` connection occasionally returns the same
 * studio more than once for a single media — typically when the
 * underlying `StudioEdge` array has two edges for the same studio
 * (e.g. one with `isMain: true` plus a secondary producer credit).
 * The `nodes` view flattens edges one-to-one, so duplicates leak
 * through. Dedupe by studio id keeping the FIRST occurrence so the
 * `sort_order` in the matching `mapMediaStudioRows` call agrees
 * (both walk nodes in the same order).
 */
export function mapStudioRows(media: AnilistMediaGql, now: number): StudioRow[] {
  const nodes = media.studios?.nodes ?? [];
  const seen = new Set<number>();
  const rows: StudioRow[] = [];
  for (const s of nodes) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    rows.push({ id: s.id, name: s.name, fetched_at: now });
  }
  return rows;
}

/**
 * Junction rows for media → studio with 0-based sort_order.
 *
 * Deduped by studio id — the `media_studio` PK is (media_id,
 * studio_id), so an AniList duplicate in `studios.nodes` would
 * otherwise blow the import with a UNIQUE constraint failure.
 * sort_order is assigned by the FILTERED iteration so the surviving
 * studios get contiguous 0..N-1 values.
 */
export function mapMediaStudioRows(media: AnilistMediaGql): MediaStudioRow[] {
  const nodes = media.studios?.nodes ?? [];
  const seen = new Set<number>();
  const rows: MediaStudioRow[] = [];
  for (const s of nodes) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    rows.push({
      media_id: media.id,
      studio_id: s.id,
      sort_order: rows.length,
    });
  }
  return rows;
}

/**
 * Returns one TagRow per unique tag referenced by the media. AniList
 * normalises tag names so duplicates are rare, but the dedup is
 * cheap insurance against the same UNIQUE-constraint failure mode as
 * studios (the `media_tag` PK is (media_id, tag_name)).
 */
export function mapTagRows(media: AnilistMediaGql, now: number): TagRow[] {
  const tags = media.tags ?? [];
  const seen = new Set<string>();
  const rows: TagRow[] = [];
  for (const t of tags) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    rows.push({ name: t.name, fetched_at: now });
  }
  return rows;
}

/** Junction rows for media → tag with per-media rank, deduped by tag name. */
export function mapMediaTagRows(media: AnilistMediaGql): MediaTagRow[] {
  const tags = media.tags ?? [];
  const seen = new Set<string>();
  const rows: MediaTagRow[] = [];
  for (const t of tags) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    rows.push({
      media_id: media.id,
      tag_name: t.name,
      rank: t.rank,
    });
  }
  return rows;
}

/**
 * `MediaList` entry → SQL row. `score` is already POINT_100 normalized by
 * the server. A score of `0` is AniList's "not rated" sentinel; we keep
 * it as 0 here (not `null`) so the data round-trips faithfully — the UI
 * must render `0` as blank.
 *
 * AniList's `createdAt` / `updatedAt` come back as SECONDS since epoch;
 * we multiply by 1000 here so the column is comparable to JavaScript
 * `Date.now()` values and the local `fetched_at` / `updated_at`. Null
 * source values (pre-feature entries) pass through unchanged.
 */
export function mapMediaListEntryRow(
  entry: AnilistMediaListEntryGql,
  anilistUserId: number,
  now: number,
): MediaListEntryRow {
  const started = fuzzyDateParts(entry.startedAt ?? null);
  const completed = fuzzyDateParts(entry.completedAt ?? null);
  return {
    anilist_user_id: anilistUserId,
    media_id: entry.media.id,
    score: entry.score,
    status: entry.status,
    repeat: entry.repeat ?? null,
    started_year: started.year,
    started_month: started.month,
    started_day: started.day,
    completed_year: completed.year,
    completed_month: completed.month,
    completed_day: completed.day,
    anilist_created_at: entry.createdAt != null ? entry.createdAt * 1000 : null,
    anilist_updated_at: entry.updatedAt != null ? entry.updatedAt * 1000 : null,
    notes: entry.notes ?? null,
    fetched_at: now,
    updated_at: now,
  };
}

export function mapCharacterRow(c: AnilistCharacterGql, now: number): CharacterRow {
  const birth = fuzzyDateParts(c.dateOfBirth ?? null);
  return {
    id: c.id,
    name_full: c.name.full ?? null,
    name_native: c.name.native ?? null,
    name_alternatives_json: stringArrayJson(c.name.alternative),
    name_alternatives_spoiler_json: stringArrayJson(c.name.alternativeSpoiler),
    image: c.image?.large ?? null,
    age: c.age ?? null,
    gender: c.gender ?? null,
    favourites: c.favourites ?? null,
    birth_year: birth.year,
    birth_month: birth.month,
    birth_day: birth.day,
    fetched_at: now,
    updated_at: now,
  };
}

/** Rehydrate AniList-style `dateOfBirth` from cached `character.birth_*` columns. */
export function characterDateOfBirthFromRow(parts: {
  birth_year?: number | null;
  birth_month?: number | null;
  birth_day?: number | null;
}): { year?: number | null; month?: number | null; day?: number | null } | null {
  const year = parts.birth_year ?? null;
  const month = parts.birth_month ?? null;
  const day = parts.birth_day ?? null;
  if (year === null && month === null && day === null) {
    return null;
  }
  return { year, month, day };
}

export function mapStaffRow(s: AnilistStaffGql, now: number): StaffRow {
  return {
    id: s.id,
    name_full: s.name.full ?? null,
    name_native: s.name.native ?? null,
    image: s.image?.large ?? null,
    age: s.age ?? null,
    gender: s.gender ?? null,
    language_v2: s.languageV2 ?? null,
    favourites: s.favourites ?? null,
    fetched_at: now,
    updated_at: now,
  };
}

/**
 * Junction rows for media → character. PK is (media_id, character_id),
 * so the mapper must emit at most one row per character_id even when
 * the upstream `edges` array repeats one.
 *
 * AniList's `Media.characters` connection paginates with a non-stable
 * sort under ties (role + favourites), so the same character edge can
 * legitimately appear across two pages — fetched contiguously by
 * `lazyExpansion.ts`, then handed here as one merged array. Without
 * dedup the rebuild transaction would fail with SQLITE_CONSTRAINT_PRIMARYKEY
 * on the first repeat and roll the whole expansion back.
 *
 * Keep the FIRST occurrence (and its sort_order) so the order on screen
 * matches the order AniList showed first — later pages re-show the same
 * character later in the merged list, which would push primary cast to
 * the bottom if "last wins" were used instead.
 */
/** Skip AniList edges whose `node` was nulled (deleted/blocked media). */
function mediaNodeId(node: AnilistMediaGql | null | undefined): number | null {
  const id = node?.id;
  return id === null || id === undefined ? null : id;
}

/** Skip null slots in nested character lists. */
function characterNodeId(
  character: AnilistCharacterGql | null | undefined,
): number | null {
  const id = character?.id;
  return id === null || id === undefined ? null : id;
}

/**
 * Junction rows for media → staff (production credits). PK is
 * (media_id, staff_id, role) — dedupe by that tuple before insert.
 */
/** `Staff.staffMedia` → `media_staff` rows for a fixed staff person. */
export function mapStaffFilmographyMediaStaffRows(
  staffId: number,
  edges: readonly { staffRole: string | null; node: AnilistMediaGql | null }[],
): MediaStaffRow[] {
  const seen = new Set<string>();
  const rows: MediaStaffRow[] = [];
  for (const [idx, e] of edges.entries()) {
    const mediaId = mediaNodeId(e.node);
    if (mediaId === null) {
      continue;
    }
    const role = (e.staffRole ?? '').trim() || 'Unknown';
    const key = `${mediaId}\0${role}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      media_id: mediaId,
      staff_id: staffId,
      role,
      sort_order: idx,
    });
  }
  return rows;
}

/**
 * VA reverse credits from `Staff.characterMedia` — upsert media/character
 * junctions and a CVA row for the staff person on each appearance.
 */
export function mapStaffCharacterAppearanceData(
  staffId: number,
  edges: readonly {
    characterRole: AnilistCharacterRole | null;
    characters: readonly (AnilistCharacterGql | null)[];
    node: AnilistMediaGql | null;
  }[],
  language: AnilistStaffLanguage,
  now: number,
): {
  mediaRows: ReturnType<typeof mapMediaStubRow>[];
  characterRows: CharacterRow[];
  mediaCharacterRows: MediaCharacterRow[];
  cvaRows: CharacterVoiceActorRow[];
} {
  const mediaById = new Map<number, ReturnType<typeof mapMediaStubRow>>();
  const characterById = new Map<number, CharacterRow>();
  const mediaCharacterSeen = new Set<string>();
  const mediaCharacterRows: MediaCharacterRow[] = [];
  const cvaSeen = new Set<string>();
  const cvaRows: CharacterVoiceActorRow[] = [];

  let sortOrder = 0;
  for (const e of edges) {
    const mediaId = mediaNodeId(e.node);
    if (mediaId === null || !e.node) {
      continue;
    }
    if (!mediaById.has(mediaId)) {
      mediaById.set(mediaId, mapMediaStubRow(e.node, now));
    }
    const role = e.characterRole ?? null;
    for (const character of e.characters ?? []) {
      const characterId = characterNodeId(character);
      if (characterId === null || !character) {
        continue;
      }
      if (!characterById.has(characterId)) {
        characterById.set(characterId, mapCharacterRow(character, now));
      }
      const mcKey = `${mediaId}:${characterId}`;
      if (!mediaCharacterSeen.has(mcKey)) {
        mediaCharacterSeen.add(mcKey);
        mediaCharacterRows.push({
          media_id: mediaId,
          character_id: characterId,
          role,
          sort_order: sortOrder,
        });
        sortOrder += 1;
      }
      const cvaKey = `${mediaId}:${characterId}:${staffId}`;
      if (!cvaSeen.has(cvaKey)) {
        cvaSeen.add(cvaKey);
        cvaRows.push({
          media_id: mediaId,
          character_id: characterId,
          staff_id: staffId,
          language,
        });
      }
    }
  }

  return {
    mediaRows: [...mediaById.values()],
    characterRows: [...characterById.values()],
    mediaCharacterRows,
    cvaRows,
  };
}

/**
 * Character filmography from `Character.media` — upsert media/staff rows,
 * junctions, and JP CVA rows for one character across their appearances.
 */
export function mapCharacterMediaAppearanceData(
  characterId: number,
  edges: readonly {
    characterRole: AnilistCharacterRole | null;
    node: AnilistMediaGql | null;
    voiceActors: readonly AnilistStaffGql[];
  }[],
  language: AnilistStaffLanguage,
  now: number,
): {
  mediaRows: ReturnType<typeof mapMediaStubRow>[];
  staffRows: StaffRow[];
  mediaCharacterRows: MediaCharacterRow[];
  cvaRows: CharacterVoiceActorRow[];
} {
  const mediaById = new Map<number, ReturnType<typeof mapMediaStubRow>>();
  const staffById = new Map<number, StaffRow>();
  const mediaCharacterSeen = new Set<string>();
  const mediaCharacterRows: MediaCharacterRow[] = [];
  const cvaSeen = new Set<string>();
  const cvaRows: CharacterVoiceActorRow[] = [];
  let sortOrder = 0;

  for (const e of edges) {
    const mediaId = mediaNodeId(e.node);
    if (mediaId === null || !e.node) {
      continue;
    }
    if (!mediaById.has(mediaId)) {
      mediaById.set(mediaId, mapMediaStubRow(e.node, now));
    }
    const mcKey = `${mediaId}:${characterId}`;
    if (!mediaCharacterSeen.has(mcKey)) {
      mediaCharacterSeen.add(mcKey);
      mediaCharacterRows.push({
        media_id: mediaId,
        character_id: characterId,
        role: e.characterRole ?? null,
        sort_order: sortOrder,
      });
      sortOrder += 1;
    }
    for (const va of e.voiceActors ?? []) {
      if (!staffById.has(va.id)) {
        staffById.set(va.id, mapStaffRow(va, now));
      }
      const cvaKey = `${mediaId}:${characterId}:${va.id}`;
      if (!cvaSeen.has(cvaKey)) {
        cvaSeen.add(cvaKey);
        cvaRows.push({
          media_id: mediaId,
          character_id: characterId,
          staff_id: va.id,
          language,
        });
      }
    }
  }

  return {
    mediaRows: [...mediaById.values()],
    staffRows: [...staffById.values()],
    mediaCharacterRows,
    cvaRows,
  };
}

export function mapMediaStaffRows(
  mediaId: number,
  edges: AnilistMediaStaffEdgeGql[],
): MediaStaffRow[] {
  const seen = new Set<string>();
  const rows: MediaStaffRow[] = [];
  for (const [idx, e] of edges.entries()) {
    const role = (e.role ?? '').trim() || 'Unknown';
    const key = `${e.node.id}\0${role}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      media_id: mediaId,
      staff_id: e.node.id,
      role,
      sort_order: idx,
    });
  }
  return rows;
}

export function mapMediaCharacterRows(
  mediaId: number,
  edges: AnilistMediaCharacterEdgeGql[],
): MediaCharacterRow[] {
  const seen = new Set<number>();
  const rows: MediaCharacterRow[] = [];
  for (const [idx, e] of edges.entries()) {
    if (seen.has(e.node.id)) continue;
    seen.add(e.node.id);
    rows.push({
      media_id: mediaId,
      character_id: e.node.id,
      role: e.role ?? null,
      sort_order: idx,
    });
  }
  return rows;
}

/**
 * Junction rows for character → voice actor. `language` is the row value
 * written for every VA in the response. The caller (`lazyExpansion`) is
 * responsible for passing the same language it injected into the GraphQL
 * `voiceActors(language: …)` filter via `buildMediaDetailQuery` — both
 * derive from one resolved value, so the DB row label can't drift from
 * what the server actually returned. Edges with empty `voiceActors`
 * arrays are simply skipped — no junction row for them.
 *
 * PK is (media_id, character_id, staff_id, language); the mapper must
 * emit a unique row per (character_id, staff_id) within a single call
 * (the `language` argument is fixed, and `mediaId` is fixed). Two known
 * sources of duplicates:
 *   1. AniList returning the same VA twice inside ONE character's
 *      `voiceActors` array. A real API quirk we've hit in the wild
 *      (e.g. a VA credited under multiple staff aliases that resolve
 *      to the same id).
 *   2. The same character edge appearing across paginated `characters`
 *      connection pages (see `mapMediaCharacterRows` for the upstream
 *      detail) — that re-emits the character's full VA list, so each
 *      (character_id, staff_id) tuple repeats.
 *
 * Without dedup either case fails the rebuild transaction with
 * SQLITE_CONSTRAINT_PRIMARYKEY and rolls the whole lazy expansion back.
 * Keep the first occurrence so order of arrival is preserved (matches
 * how AniList first presented the VA — primary credit first).
 */
export function mapCharacterVoiceActorRows(
  mediaId: number,
  edges: AnilistMediaCharacterEdgeGql[],
  language: AnilistStaffLanguage,
): CharacterVoiceActorRow[] {
  const rows: CharacterVoiceActorRow[] = [];
  // Composite-key set: `${character_id}:${staff_id}` is sufficient
  // because mediaId + language are both fixed for the whole call.
  const seen = new Set<string>();
  for (const edge of edges) {
    for (const va of edge.voiceActors ?? []) {
      const key = `${edge.node.id}:${va.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        media_id: mediaId,
        character_id: edge.node.id,
        staff_id: va.id,
        language,
      });
    }
  }
  return rows;
}

export function mapMediaFavouriteRow(
  edge: AnilistFavouriteEdge<AnilistMediaGql>,
  anilistUserId: number,
  now: number,
): MediaFavouriteRow {
  return {
    anilist_user_id: anilistUserId,
    media_id: edge.node.id,
    sort_order: edge.favouriteOrder,
    fetched_at: now,
  };
}

export function mapCharacterFavouriteRow(
  edge: AnilistFavouriteEdge<AnilistCharacterGql>,
  anilistUserId: number,
  now: number,
): CharacterFavouriteRow {
  return {
    anilist_user_id: anilistUserId,
    character_id: edge.node.id,
    sort_order: edge.favouriteOrder,
    fetched_at: now,
  };
}

export function mapStaffFavouriteRow(
  edge: AnilistFavouriteEdge<AnilistStaffGql>,
  anilistUserId: number,
  now: number,
): StaffFavouriteRow {
  return {
    anilist_user_id: anilistUserId,
    staff_id: edge.node.id,
    sort_order: edge.favouriteOrder,
    fetched_at: now,
  };
}

export function mapStudioFavouriteRow(
  edge: AnilistFavouriteEdge<AnilistFavouriteStudioNode>,
  anilistUserId: number,
  now: number,
): StudioFavouriteRow {
  return {
    anilist_user_id: anilistUserId,
    studio_id: edge.node.id,
    sort_order: edge.favouriteOrder,
    fetched_at: now,
  };
}

/**
 * Triple identifying a row in `custom_list`. Doesn't map directly to
 * `CustomListRow` because that table's primary key is autoincrement
 * (filled by SQLite at insert time); the importer needs to upsert the
 * triple, read back the id, then use it to build
 * `media_custom_list_membership` rows.
 *
 * Per AniList's server model, the same name on (ANIME, MANGA) is two
 * separate buckets — we preserve that by keying on media_type.
 */
export type CustomListIdentity = {
  anilist_user_id: number;
  name: string;
  media_type: AnilistMediaGql['type'];
};

/**
 * Pull every (user, name, type) triple referenced by a page of list
 * entries. Returns a de-duplicated array in iteration order. Pure —
 * does no DB I/O; the importer dedupes again across pages and feeds
 * the result into the custom_list upsert.
 *
 * Only emits identities for `{enabled: true}` flags: AniList's
 * `customLists(asArray: true)` returns one element per list the user
 * has DEFINED (regardless of whether the entry is in it), so
 * `enabled: false` is a meaningful "list exists, this entry isn't in
 * it" signal — promoting those to identities would create a
 * `custom_list` row that no `media_custom_list_membership` row ever
 * references, and the importer's GC step (8) would prune it again on
 * the next refresh anyway. Filtering here keeps the upsert batch
 * small and makes the (custom_list ↔ membership) relationship total
 * by construction.
 */
export function collectCustomListIdentities(
  entries: AnilistMediaListEntryGql[],
  anilistUserId: number,
): CustomListIdentity[] {
  const seen = new Set<string>();
  const out: CustomListIdentity[] = [];
  for (const entry of entries) {
    const type = entry.media.type;
    for (const membership of entry.customLists ?? []) {
      if (!membership?.enabled) continue;
      const name = membership.name;
      const key = `${type}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ anilist_user_id: anilistUserId, name, media_type: type });
    }
  }
  return out;
}
