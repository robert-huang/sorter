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
  AnilistFavouriteEdge,
  AnilistFavouriteStudioNode,
  AnilistFuzzyDate,
  AnilistMediaCharacterEdgeGql,
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

/** Returns one StudioRow per unique studio referenced by the media. */
export function mapStudioRows(media: AnilistMediaGql, now: number): StudioRow[] {
  const nodes = media.studios?.nodes ?? [];
  return nodes.map((s) => ({ id: s.id, name: s.name, fetched_at: now }));
}

/** Junction rows for media → studio with 0-based sort_order. */
export function mapMediaStudioRows(media: AnilistMediaGql): MediaStudioRow[] {
  const nodes = media.studios?.nodes ?? [];
  return nodes.map((s, idx) => ({
    media_id: media.id,
    studio_id: s.id,
    sort_order: idx,
  }));
}

/** Returns one TagRow per unique tag referenced by the media. */
export function mapTagRows(media: AnilistMediaGql, now: number): TagRow[] {
  const tags = media.tags ?? [];
  return tags.map((t) => ({ name: t.name, fetched_at: now }));
}

/** Junction rows for media → tag with per-media rank. */
export function mapMediaTagRows(media: AnilistMediaGql): MediaTagRow[] {
  const tags = media.tags ?? [];
  return tags.map((t) => ({
    media_id: media.id,
    tag_name: t.name,
    rank: t.rank,
  }));
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
    fetched_at: now,
    updated_at: now,
  };
}

export function mapCharacterRow(c: AnilistCharacterGql, now: number): CharacterRow {
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
    fetched_at: now,
    updated_at: now,
  };
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
 * Junction rows for media → character. `sort_order` preserves AniList's
 * connection ordering (which already encodes ROLE → RELEVANCE → ID per
 * the sort argument).
 */
export function mapMediaCharacterRows(
  mediaId: number,
  edges: AnilistMediaCharacterEdgeGql[],
): MediaCharacterRow[] {
  return edges.map((e, idx) => ({
    media_id: mediaId,
    character_id: e.node.id,
    role: e.role ?? null,
    sort_order: idx,
  }));
}

/**
 * Junction rows for character → voice actor. `language` is the row value
 * written for every VA in the response. The caller (`lazyExpansion`) is
 * responsible for passing the same language it injected into the GraphQL
 * `voiceActors(language: …)` filter via `buildMediaDetailQuery` — both
 * derive from one resolved value, so the DB row label can't drift from
 * what the server actually returned. Edges with empty `voiceActors`
 * arrays are simply skipped — no junction row for them.
 */
export function mapCharacterVoiceActorRows(
  mediaId: number,
  edges: AnilistMediaCharacterEdgeGql[],
  language: AnilistStaffLanguage,
): CharacterVoiceActorRow[] {
  const rows: CharacterVoiceActorRow[] = [];
  for (const edge of edges) {
    for (const va of edge.voiceActors ?? []) {
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
 */
export function collectCustomListIdentities(
  entries: AnilistMediaListEntryGql[],
  anilistUserId: number,
): CustomListIdentity[] {
  const seen = new Set<string>();
  const out: CustomListIdentity[] = [];
  for (const entry of entries) {
    const type = entry.media.type;
    for (const name of entry.customLists ?? []) {
      const key = `${type}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ anilist_user_id: anilistUserId, name, media_type: type });
    }
  }
  return out;
}
