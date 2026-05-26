/**
 * AniList type surface. Three layers, kept in one file because they're
 * tightly coupled and small:
 *
 *   1. AniList GraphQL enums + scalar shapes (mirrors the public schema).
 *   2. GraphQL response shapes for the queries defined in the plan §A
 *      (ListPage, MediaDetail, per-type Favourites).
 *   3. Local SQLite row shapes (mirrors `migrations/001-init.sql` exactly).
 *
 * The importer (separate chunk) is the only thing that should know how to
 * map (2) → (3); UI consumers should only see (3).
 */

// ──────────────────────────────────────────────────────────────────────
// 1. AniList enums and scalars
// ──────────────────────────────────────────────────────────────────────

/** AniList MediaType — only ANIME and MANGA at the connection-level for v1. */
export type AnilistMediaType = 'ANIME' | 'MANGA';

/** AniList MediaFormat — superset across both media types. */
export type AnilistMediaFormat =
  | 'TV'
  | 'TV_SHORT'
  | 'MOVIE'
  | 'SPECIAL'
  | 'OVA'
  | 'ONA'
  | 'MUSIC'
  | 'MANGA'
  | 'NOVEL'
  | 'ONE_SHOT';

/** AniList MediaStatus (release / publication status). */
export type AnilistMediaStatus =
  | 'FINISHED'
  | 'RELEASING'
  | 'NOT_YET_RELEASED'
  | 'CANCELLED'
  | 'HIATUS';

/** AniList MediaSeason. */
export type AnilistMediaSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

/** AniList MediaListStatus — the user's own status on a list entry. */
export type AnilistMediaListStatus =
  | 'CURRENT'
  | 'PLANNING'
  | 'COMPLETED'
  | 'DROPPED'
  | 'PAUSED'
  | 'REPEATING';

/** AniList CharacterRole. */
export type AnilistCharacterRole = 'MAIN' | 'SUPPORTING' | 'BACKGROUND';

/**
 * AniList StaffLanguage. v1 defaults to JAPANESE but the value is a
 * parameter (`voiceActorLanguage`) threaded through both the GraphQL
 * query builder and the `character_voice_actor` insert so the two stay
 * in lock-step; the schema's PK includes the language column so future
 * languages slot in without a migration.
 */
export type AnilistStaffLanguage =
  | 'JAPANESE'
  | 'ENGLISH'
  | 'KOREAN'
  | 'CHINESE'
  | 'FRENCH'
  | 'SPANISH'
  | 'PORTUGUESE'
  | 'ITALIAN'
  | 'GERMAN'
  | 'HEBREW'
  | 'HUNGARIAN';

/** AniList's FuzzyDate scalar — every field is independently nullable. */
export type AnilistFuzzyDate = {
  year: number | null;
  month: number | null;
  day: number | null;
};

// ──────────────────────────────────────────────────────────────────────
// 2. GraphQL response shapes
// ──────────────────────────────────────────────────────────────────────

/**
 * Shared Media field selection used by both list-page imports and lazy
 * detail. `description` and `duration` deliberately omitted (see plan §A).
 *
 * `countryOfOrigin` is AniList's ISO 3166-1 alpha-2 (`JP` / `KR` / `CN` /
 * `TW` / …); useful for distinguishing donghua/aeni from anime even when
 * `format` and `type` are identical.
 *
 * `synonyms` is the AniList alternative-title list (SnK, AoT, …). Stored
 * as JSON; used as a fallback title-search index for non-canonical names.
 */
export type AnilistMediaGql = {
  id: number;
  type: AnilistMediaType;
  title: {
    english: string | null;
    romaji: string | null;
    native: string | null;
  };
  coverImage: { large: string | null } | null;
  format: AnilistMediaFormat | null;
  status: AnilistMediaStatus | null;
  episodes: number | null;
  chapters: number | null;
  startDate: AnilistFuzzyDate | null;
  endDate: AnilistFuzzyDate | null;
  season: AnilistMediaSeason | null;
  seasonYear: number | null;
  meanScore: number | null;
  favourites: number | null;
  countryOfOrigin: string | null;
  genres: string[] | null;
  synonyms: string[] | null;
  studios: { nodes: Array<{ id: number; name: string }> } | null;
  tags: Array<{ name: string; rank: number }> | null;
};

export type AnilistPageInfo = {
  hasNextPage: boolean;
  currentPage: number;
  lastPage: number | null;
  total: number | null;
};

/**
 * A single user-list-entry edge in a `Page(...) { mediaList(...) }`
 * response.
 *
 * `customLists` is AniList's per-user named buckets (returned as
 * `MediaList.customLists(asArray: true)` — the array form gives a
 * stable string[] of names instead of a `{name: bool}` map). The
 * importer normalises this into the local `custom_list` +
 * `media_custom_list_membership` tables.
 *
 * `repeat`, `createdAt`, `updatedAt` come from the underlying
 * `MediaList` fields. `createdAt` / `updatedAt` are SECONDS-since-epoch
 * (AniList convention); importer × 1000 before insert.
 */
export type AnilistMediaListEntryGql = {
  /**
   * Server-normalized to 0-100 via the GraphQL field arg `score(format:
   * POINT_100)`. `0` means "not rated" per AniList convention regardless of
   * the user's MediaListOptions.scoreFormat.
   */
  score: number;
  status: AnilistMediaListStatus;
  repeat: number | null;
  startedAt: AnilistFuzzyDate | null;
  completedAt: AnilistFuzzyDate | null;
  /** AniList `MediaList.createdAt`; SECONDS since epoch, nullable for pre-feature entries. */
  createdAt: number | null;
  /** AniList `MediaList.updatedAt`; SECONDS since epoch, nullable. */
  updatedAt: number | null;
  /** Names of the user's customLists this entry belongs to; empty array when unaffiliated. */
  customLists: string[];
  media: AnilistMediaGql;
};

/** `Page.mediaList` response, paginated by username + type. */
export type AnilistListPageResponse = {
  Page: {
    pageInfo: AnilistPageInfo;
    mediaList: AnilistMediaListEntryGql[];
  };
};

/**
 * `User(name:)` resolution — used by the importer to map the
 * caller-supplied username to the stable AniList User.id once per
 * import run. PK on id rather than name in our local schema so
 * subsequent renames don't fork the row.
 */
export type AnilistUserResolveResponse = {
  User: {
    id: number;
    name: string;
  } | null;
};

/**
 * Character node (lazy fetch only — populated on detail view).
 *
 * `alternative` is non-spoiler aliases (English/romaji variants,
 * nicknames). `alternativeSpoiler` is post-twist names / true
 * identities — fetched + stored unconditionally and gated for display
 * at render time by a per-user "show spoilers" toggle. Search matches
 * against both: if a user types a spoiler alias they already know it.
 */
export type AnilistCharacterGql = {
  id: number;
  name: {
    full: string | null;
    native: string | null;
    alternative: string[] | null;
    alternativeSpoiler: string[] | null;
  };
  image: { large: string | null } | null;
  age: string | null;
  gender: string | null;
  favourites: number | null;
};

/**
 * Staff node (used both as VA inside character edges and as top-level
 * staff). `languageV2` is AniList's free-form display string
 * ("Japanese" / "English" / …) — NOT the uppercase `StaffLanguage`
 * enum used by `voiceActors(language:)`. Stored on the row so the UI
 * can badge a VA's primary language without re-joining through
 * character_voice_actor.
 */
export type AnilistStaffGql = {
  id: number;
  name: { full: string | null; native: string | null };
  languageV2: string | null;
  image: { large: string | null } | null;
  age: string | null;
  gender: string | null;
  favourites: number | null;
};

/**
 * `Media.characters` connection edge — one row per character with the
 * inline-fetched voice actors. The `voiceActors` array uses a server-
 * side language filter (set by `buildMediaDetailQuery` from the same
 * `voiceActorLanguage` value the importer writes to the DB), so all
 * entries share one language and we don't have to inspect them per-row.
 */
export type AnilistMediaCharacterEdgeGql = {
  role: AnilistCharacterRole | null;
  node: AnilistCharacterGql;
  voiceActors: AnilistStaffGql[];
};

/** `Media.staff` connection edge — used by detail panels for the credits list. */
export type AnilistMediaStaffEdgeGql = {
  role: string | null;
  node: AnilistStaffGql;
};

/** Response shape for the lazy `Media(id:)` characters+staff fetch. */
export type AnilistMediaDetailResponse = {
  Media: {
    id: number;
    characters: {
      pageInfo: Pick<AnilistPageInfo, 'hasNextPage' | 'currentPage'>;
      edges: AnilistMediaCharacterEdgeGql[];
    } | null;
    staff: {
      pageInfo: Pick<AnilistPageInfo, 'hasNextPage' | 'currentPage'>;
      edges: AnilistMediaStaffEdgeGql[];
    } | null;
  } | null;
};

/** Shared favourite-edge wrapper (parameterized by node type). */
export type AnilistFavouriteEdge<TNode> = {
  /**
   * The user's preferred ordering on AniList (mutable from their profile).
   * Cached as `sort_order` in `<type>_favourite`; goes stale until next
   * favourites refresh.
   */
  favouriteOrder: number;
  node: TNode;
};

export type AnilistFavouriteStudioNode = { id: number; name: string };

/**
 * Per-type favourites response. The `User.favourites.<connection>` shape is
 * uniform — only the node type changes per connection.
 */
export type AnilistFavouritesPageResponse<TNode> = {
  User: {
    favourites: {
      [connection: string]: {
        pageInfo: Pick<AnilistPageInfo, 'hasNextPage' | 'currentPage'>;
        edges: AnilistFavouriteEdge<TNode>[];
      };
    };
  } | null;
};

/** Convenience aliases — one per favourites connection. */
export type AnilistFavouriteAnimePageResponse = AnilistFavouritesPageResponse<AnilistMediaGql>;
export type AnilistFavouriteMangaPageResponse = AnilistFavouritesPageResponse<AnilistMediaGql>;
export type AnilistFavouriteCharactersPageResponse =
  AnilistFavouritesPageResponse<AnilistCharacterGql>;
export type AnilistFavouriteStaffPageResponse = AnilistFavouritesPageResponse<AnilistStaffGql>;
export type AnilistFavouriteStudiosPageResponse =
  AnilistFavouritesPageResponse<AnilistFavouriteStudioNode>;

/**
 * Discriminator for the favourites dropdown UI. Maps 1:1 to the AniList
 * `User.favourites.<connection>` connection names (lowercased).
 */
export type AnilistFavouriteType = 'ANIME' | 'MANGA' | 'CHARACTERS' | 'STAFF' | 'STUDIOS';

// ──────────────────────────────────────────────────────────────────────
// 3. SQLite row shapes (mirror migrations/001-init.sql)
// ──────────────────────────────────────────────────────────────────────

/**
 * Row shape for the `anilist_user` table — one row per AniList user
 * whose data lives in this DB. Importer upserts on (id) and refreshes
 * `name` on every run since AniList allows renames.
 */
export type AnilistUserRow = {
  id: number;
  name: string;
  fetched_at: number;
  updated_at: number;
};

/** Row shape for the `media` table. */
export type MediaRow = {
  id: number;
  type: AnilistMediaType;
  title_english: string | null;
  title_romaji: string | null;
  title_native: string | null;
  cover_image: string | null;
  format: AnilistMediaFormat | null;
  status: AnilistMediaStatus | null;
  episodes: number | null;
  chapters: number | null;
  start_year: number | null;
  start_month: number | null;
  start_day: number | null;
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
  season: AnilistMediaSeason | null;
  season_year: number | null;
  mean_score: number | null;
  favourites: number | null;
  /** ISO 3166-1 alpha-2 (`JP`/`KR`/`CN`/`TW`/…). */
  country_of_origin: string | null;
  /** JSON-stringified `string[]` of genre names. */
  genres_json: string | null;
  /** JSON-stringified `string[]` of alternative titles. */
  synonyms_json: string | null;
  fetched_at: number;
  updated_at: number;
};

export type StudioRow = {
  id: number;
  name: string;
  fetched_at: number;
};

export type TagRow = {
  name: string;
  fetched_at: number;
};

export type CharacterRow = {
  id: number;
  name_full: string | null;
  name_native: string | null;
  /** JSON-stringified `string[]` of non-spoiler aliases. */
  name_alternatives_json: string | null;
  /** JSON-stringified `string[]` of spoiler aliases (gated for display by UI). */
  name_alternatives_spoiler_json: string | null;
  image: string | null;
  age: string | null;
  gender: string | null;
  favourites: number | null;
  fetched_at: number;
  updated_at: number;
};

export type StaffRow = {
  id: number;
  name_full: string | null;
  name_native: string | null;
  image: string | null;
  age: string | null;
  gender: string | null;
  /** AniList `Staff.languageV2`; free-form display string, not the StaffLanguage enum. */
  language_v2: string | null;
  favourites: number | null;
  fetched_at: number;
  updated_at: number;
};

export type MediaStudioRow = {
  media_id: number;
  studio_id: number;
  sort_order: number;
};

export type MediaTagRow = {
  media_id: number;
  tag_name: string;
  rank: number;
};

export type MediaCharacterRow = {
  media_id: number;
  character_id: number;
  role: AnilistCharacterRole | null;
  sort_order: number;
};

export type CharacterVoiceActorRow = {
  media_id: number;
  character_id: number;
  staff_id: number;
  language: AnilistStaffLanguage;
};

export type MediaListEntryRow = {
  anilist_user_id: number;
  media_id: number;
  /** 0–100 (POINT_100 normalized); 0 == not rated. */
  score: number | null;
  status: AnilistMediaListStatus;
  /** AniList `MediaList.repeat` (rewatch/reread count); null if never set. */
  repeat: number | null;
  started_year: number | null;
  started_month: number | null;
  started_day: number | null;
  completed_year: number | null;
  completed_month: number | null;
  completed_day: number | null;
  /** MS since epoch; AniList `createdAt` × 1000. Nullable for pre-feature entries. */
  anilist_created_at: number | null;
  /** MS since epoch; AniList `updatedAt` × 1000. Nullable, same caveat. */
  anilist_updated_at: number | null;
  fetched_at: number;
  updated_at: number;
};

/**
 * Row shape for the `custom_list` table — one row per (user, name,
 * media_type). Per-media-type separation matches AniList's server-side
 * model: "Top 2023" for ANIME and "Top 2023" for MANGA are distinct
 * buckets even though the names collide.
 *
 * Natural-key PK (no autoincrement) so importers can insert lists +
 * memberships in the same execBatch without a SELECT round-trip to
 * learn assigned ids.
 */
export type CustomListRow = {
  anilist_user_id: number;
  name: string;
  media_type: AnilistMediaType;
  fetched_at: number;
  updated_at: number;
};

/**
 * Row shape for `media_custom_list_membership`. CASCADE on the
 * (anilist_user_id, media_id) FK to media_list_entry means the
 * importer's per-user list wipe automatically clears stale memberships
 * without a separate DELETE.
 *
 * `media_type` is denormalised (could be inferred via media.type for
 * media_id) but kept on the row so the FK back to custom_list can be
 * composite — the importer is the only writer and never violates
 * media_type == media.type, so no enforcement trigger is needed.
 */
export type MediaCustomListMembershipRow = {
  anilist_user_id: number;
  media_id: number;
  custom_list_name: string;
  media_type: AnilistMediaType;
};

export type MediaFavouriteRow = {
  anilist_user_id: number;
  media_id: number;
  sort_order: number;
  fetched_at: number;
};

export type CharacterFavouriteRow = {
  anilist_user_id: number;
  character_id: number;
  sort_order: number;
  fetched_at: number;
};

export type StaffFavouriteRow = {
  anilist_user_id: number;
  staff_id: number;
  sort_order: number;
  fetched_at: number;
};

export type StudioFavouriteRow = {
  anilist_user_id: number;
  studio_id: number;
  sort_order: number;
  fetched_at: number;
};
