/**
 * AniList GraphQL query strings. Pulled out of the importer modules so:
 *
 *   1. The importers' control-flow logic stays readable.
 *   2. Tests can snapshot / introspect the exact query text without
 *      reaching into private constants.
 *   3. The shared `MEDIA_FIELD_SELECTION` fragment is defined once and
 *      injected into every query that requests media (`ListPage`,
 *      `FavouriteAnimePage`, `FavouriteMangaPage`).
 *
 * Field selection mirrors AniList plan §A — see that doc for what's
 * deliberately *omitted* (description, duration, bannerImage, siteUrl).
 */

import type { AnilistStaffLanguage } from './types';

/**
 * Shared `Media` field selection. Inlined into the query bodies below
 * rather than declared as a GraphQL fragment to keep each query self-
 * contained and to sidestep AniList's fragment-naming requirements.
 *
 * Notes:
 *   - `score(format: POINT_100)` is a per-field argument on the parent
 *     `MediaList.score` selector — it does NOT appear here.
 *   - `tags` returns name + rank only; we don't request `isMediaSpoiler` /
 *     `category` since the LIST filter bar doesn't expose them in v1.
 *   - `endDate` joins `startDate` so the UI can render full broadcast /
 *     serialization ranges and filter by year-of-completion.
 *   - `countryOfOrigin` is the ISO 3166-1 alpha-2 origin code (JP / KR /
 *     CN / TW / …); lets the UI distinguish donghua / aeni from anime
 *     even when format + type are identical.
 *   - `synonyms` is AniList's alternative-title array (SnK, AoT, …);
 *     stored as JSON for the title-search fallback index.
 *   - `source(version: 3)` — WEB_NOVEL and other v3-only enum values are
 *     absent from the default (v1) MediaSource field.
 *   - `status(version: 2)` — HIATUS and other v2-only MediaStatus values are
 *     absent from the default (v1) Media.status field.
 */
export const ANILIST_MEDIA_SOURCE_VERSION = 3;
export const ANILIST_MEDIA_STATUS_VERSION = 2;
export const ANILIST_MEDIA_RELATION_TYPE_VERSION = 2;

const MEDIA_SOURCE_SELECTION = `source(version: ${ANILIST_MEDIA_SOURCE_VERSION})`;
const MEDIA_STATUS_SELECTION = `status(version: ${ANILIST_MEDIA_STATUS_VERSION})`;

/**
 * MediaRelation v2: adds SOURCE/COMPILATION/CONTAINS and fixes cross-medium
 * SOURCE/ADAPTATION direction. Use on every tools + graph relation fetch.
 */
export const TOOLS_MEDIA_RELATION_TYPE_FIELD = `relationType(version: ${ANILIST_MEDIA_RELATION_TYPE_VERSION})`;

const MEDIA_FIELD_SELECTION = `
  id
  type
  title { english romaji native }
  coverImage { large }
  format
  ${MEDIA_SOURCE_SELECTION}
  ${MEDIA_STATUS_SELECTION}
  episodes
  chapters
  startDate { year month day }
  endDate { year month day }
  season
  seasonYear
  meanScore
  favourites
  countryOfOrigin
  genres
  synonyms
  studios { nodes { id name } }
  tags { name rank }
`.trim();

/**
 * Media fields for `User.favourites.anime` / `.manga` pagination.
 *
 * Same as {@link MEDIA_FIELD_SELECTION} **except `studios` is omitted**.
 * Requesting `Media.studios` on favourite-media nodes currently makes
 * AniList's API return HTTP 500 ("Internal Server Error") — the website
 * uses a lighter selection (`title { userPreferred }`, no studios). Studio
 * junction rows for favourited media are therefore not seeded on favourites
 * import; list import / lazy expansion still populate `media_studio`.
 */
export const FAVOURITE_MEDIA_FIELD_SELECTION = `
  id
  type
  title { english romaji native }
  coverImage { large }
  format
  ${MEDIA_SOURCE_SELECTION}
  ${MEDIA_STATUS_SELECTION}
  episodes
  chapters
  startDate { year month day }
  endDate { year month day }
  season
  seasonYear
  meanScore
  favourites
  countryOfOrigin
  genres
  synonyms
  tags { name rank }
`.trim();

/**
 * One chunk of a user's full anime / manga list, fetched via the
 * `MediaListCollection` query.
 *
 *   - Variables: `$username: String!`, `$type: MediaType!` (`ANIME` | `MANGA`),
 *     `$chunk: Int!` (1-indexed), `$perChunk: Int!` (importer passes 500,
 *     AniList's documented max).
 *
 * **Why MediaListCollection instead of `Page.mediaList`.** The AniList
 * docs explicitly say `Page.mediaList` is for "a portion" of a list and
 * `MediaListCollection` is the correct query "when you really do need
 * the user's complete list." We learned this the hard way:
 *
 *   1. **`UPDATED_TIME_DESC` is unstable on ties.** Bulk-edited entries
 *      that share a timestamp get shuffled into a different order on
 *      every page request, causing massive duplication between adjacent
 *      pages. One real user (916 entries, with a chunk of ~825 that
 *      shared an updatedAt second from a mass status migration) imported
 *      as 474 unique rows because dedup ate the overlap.
 *   2. **`pageInfo.total`/`lastPage` are deprecated** per AniList's
 *      pagination docs — only `hasNextPage` is reliable. Same warning
 *      applies to `Page.mediaList`'s pagination signal.
 *   3. **Hidden custom-list entries.** Users can toggle "hide from
 *      status lists" on a custom list; those entries don't appear in
 *      `Page.mediaList` at all but DO appear in `MediaListCollection`.
 *      Not our user's case but a future-proof reason to switch.
 *   4. **Fewer requests = less rate-limit risk.** `MediaListCollection`
 *      defaults to 500 entries per chunk, so a 1000-entry list is
 *      1-2 requests vs ~20 for `Page.mediaList`. Each request shares
 *      the same 90 req/min (currently 30 req/min, degraded) bucket, so
 *      fewer requests = far smaller blast radius if a 429 lands.
 *
 * **Field selection notes** (mostly inherited from the old query):
 *   - `score(format: POINT_100)` forces server-side normalization so we
 *     don't need to track the user's MediaListOptions.scoreFormat.
 *   - `customLists(asArray: true)` returns
 *     `Array<{name: string, enabled: boolean}>` — one element per
 *     list the user has defined for this media type, with `enabled`
 *     indicating whether THIS entry is in that list. The default
 *     `customLists` field is a `{name: bool}` map carrying the same
 *     information but in a shape that's awkward to consume from
 *     strict GraphQL clients. The importer extracts the names with
 *     `enabled === true` and normalises into the local `custom_list`
 *     + `media_custom_list_membership` tables.
 *   - `createdAt` / `updatedAt` are AniList's server-side MediaList
 *     timestamps in SECONDS; the mapper multiplies by 1000 before
 *     persisting. Distinct from the row's local `fetched_at` /
 *     `updated_at` (when WE last touched the row).
 *   - `repeat` is rewatch/reread count.
 *
 * **Response shape.** `MediaListCollection.lists` is grouped by status
 * AND custom list. The same `MediaList` row appears in every group it
 * belongs to, so the importer flattens `lists[*].entries[*]` and
 * dedupes by `media.id` (first wins). This is the documented intended
 * usage — see the `customLists` field on each entry for the canonical
 * "which custom lists is this in" data.
 */
export const LIST_COLLECTION_QUERY = `
query ListCollection($username: String!, $type: MediaType!, $chunk: Int!, $perChunk: Int!) {
  MediaListCollection(userName: $username, type: $type, chunk: $chunk, perChunk: $perChunk) {
    hasNextChunk
    lists {
      name
      isCustomList
      status
      entries {
        score(format: POINT_100)
        status
        repeat
        notes
        startedAt { year month day }
        completedAt { year month day }
        createdAt
        updatedAt
        customLists(asArray: true)
        media {
          ${MEDIA_FIELD_SELECTION}
        }
      }
    }
  }
}
`.trim();

/**
 * Resolves an AniList username to a stable User.id. The importer runs
 * this once per import session, upserts the result into the
 * `anilist_user` table, and threads the id through every downstream
 * write so multiple users' data can coexist in the same DB.
 *
 *   - Variables: `$username: String!`
 *   - Returns `null` for unknown usernames; the importer treats that
 *     as a hard error (cannot import a non-existent user's list).
 */
export const RESOLVE_USER_QUERY = `
query ResolveUser($username: String!) {
  User(name: $username) {
    id
    name
  }
}
`.trim();

/**
 * Lazy detail fetch for one media id — characters with voice actors in a
 * single configurable language, and the full staff list. Both connections
 * paginate independently; importer caps `characters` at 2 pages (50
 * entries) per v1 plan.
 *
 *   - Variables: `$id: Int!`, `$charactersPage: Int!`, `$staffPage: Int!`,
 *     `$perPage: Int!` (importer passes 25).
 *   - `characters(sort: [ROLE, RELEVANCE, ID])` so MAIN comes first, then
 *     SUPPORTING by relevance, then BACKGROUND.
 *   - `voiceActors(language: …)` is interpolated from `voiceActorLanguage`
 *     so the GraphQL filter and the row inserted into
 *     `character_voice_actor.language` come from a single caller value.
 *     Bare enum (not a `$lang` variable) keeps the query body self-
 *     documenting and matches AniList's StaffLanguage enum syntax.
 *
 * AniList's response shape does not echo the requested language per VA —
 * we have to trust the server applied the filter we sent. The shared
 * source of truth makes that trust safe: the same enum value is sent to
 * AniList and written to the DB, so a future refactor cannot silently
 * mislabel ENGLISH VAs as JAPANESE (or vice versa).
 */
export function buildMediaDetailQuery({
  voiceActorLanguage,
}: {
  voiceActorLanguage: AnilistStaffLanguage;
}): string {
  return `
query MediaDetail(
  $id: Int!
  $charactersPage: Int!
  $staffPage: Int!
  $perPage: Int!
) {
  Media(id: $id) {
    id
    characters(page: $charactersPage, perPage: $perPage, sort: [ROLE, RELEVANCE, ID]) {
      pageInfo { hasNextPage currentPage }
      edges {
        role
        node {
          id
          name { full native alternative alternativeSpoiler }
          image { large }
          age
          gender
          favourites
        }
        voiceActors(language: ${voiceActorLanguage}) {
          id
          name { full native }
          languageV2
          image { large }
          age
          gender
          favourites
        }
      }
    }
    staff(page: $staffPage, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        role
        node {
          id
          name { full native }
          languageV2
          image { large }
          age
          gender
          favourites
        }
      }
    }
  }
}
`.trim();
}

/** Staff connection only — used by the second pagination loop in lazy expansion. */
export function buildMediaStaffOnlyQuery(): string {
  return `
query MediaStaffOnly($id: Int!, $staffPage: Int!, $perPage: Int!) {
  Media(id: $id) {
    id
    staff(page: $staffPage, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        role
        node {
          id
          name { full native }
          languageV2
          image { large }
          age
          gender
          favourites
        }
      }
    }
  }
}
`.trim();
}

/**
 * `User.favourites.anime` — paginated favourite anime media. Same body for
 * manga in {@link FAVOURITE_MANGA_QUERY}; AniList doesn't accept a
 * connection-type variable so the connection name has to be baked in.
 *
 *   - Variables: `$username: String!`, `$page: Int!`, `$perPage: Int!`
 *     (importer passes 25).
 *   - `favouriteOrder` is per-user mutable on AniList; cached locally as
 *     `<type>_favourite.sort_order` and goes stale until next refresh.
 *   - Node fields use {@link FAVOURITE_MEDIA_FIELD_SELECTION} — not the
 *     full {@link MEDIA_FIELD_SELECTION} (see that constant for why).
 */
export const FAVOURITE_ANIME_QUERY = `
query FavouriteAnimePage($username: String!, $page: Int!, $perPage: Int!) {
  User(name: $username) {
    favourites {
      anime(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage currentPage }
        edges {
          favouriteOrder
          node {
            ${FAVOURITE_MEDIA_FIELD_SELECTION}
          }
        }
      }
    }
  }
}
`.trim();

export const FAVOURITE_MANGA_QUERY = `
query FavouriteMangaPage($username: String!, $page: Int!, $perPage: Int!) {
  User(name: $username) {
    favourites {
      manga(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage currentPage }
        edges {
          favouriteOrder
          node {
            ${FAVOURITE_MEDIA_FIELD_SELECTION}
          }
        }
      }
    }
  }
}
`.trim();

export const FAVOURITE_CHARACTERS_QUERY = `
query FavouriteCharactersPage($username: String!, $page: Int!, $perPage: Int!) {
  User(name: $username) {
    favourites {
      characters(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage currentPage }
        edges {
          favouriteOrder
          node {
            id
            name { full native alternative alternativeSpoiler }
            image { large }
            age
            gender
            favourites
            dateOfBirth { year month day }
          }
        }
      }
    }
  }
}
`.trim();

export const FAVOURITE_STAFF_QUERY = `
query FavouriteStaffPage($username: String!, $page: Int!, $perPage: Int!) {
  User(name: $username) {
    favourites {
      staff(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage currentPage }
        edges {
          favouriteOrder
          node {
            id
            name { full native }
            languageV2
            image { large }
            age
            gender
            favourites
          }
        }
      }
    }
  }
}
`.trim();

/**
 * Staff filmography — paginate `characterMedia` (VA appearances) and
 * `staffMedia` (production credits) independently.
 * `characterMedia.edges` are `MediaEdge` (`characterRole`, not `role`);
 * `staffMedia.edges` use `staffRole`.
 */
export function buildStaffFilmographyQuery(): string {
  return `
query StaffFilmography(
  $id: Int!
  $charactersPage: Int!
  $staffMediaPage: Int!
  $perPage: Int!
) {
  Staff(id: $id) {
    id
    name { full native }
    languageV2
    image { large }
    age
    gender
    favourites
    characterMedia(page: $charactersPage, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        characterRole
        characters {
          id
          name { full native alternative alternativeSpoiler }
          image { large }
          age
          gender
          favourites
        }
        node {
          ${MEDIA_FIELD_SELECTION}
        }
      }
    }
    staffMedia(page: $staffMediaPage, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        staffRole
        node {
          ${MEDIA_FIELD_SELECTION}
        }
      }
    }
  }
}
`.trim();
}

/** Lazy franchise relations for one media id. */
export function buildMediaRelationsQuery(): string {
  return `
query MediaRelations($id: Int!) {
  Media(id: $id) {
    id
    relations {
      edges {
        ${TOOLS_MEDIA_RELATION_TYPE_FIELD}
        node {
          ${MEDIA_FIELD_SELECTION}
        }
      }
    }
  }
}
`.trim();
}

/** Title search for setup endpoint picker. */
export function buildAnimeSearchQuery(): string {
  return `
query AnimeSearch($search: String!, $page: Int!, $perPage: Int!) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
    media(search: $search, type: ANIME) {
      ${MEDIA_FIELD_SELECTION}
    }
  }
}
`.trim();
}

/** Metadata-only fetch for a single anime id (setup / ID load). */
export function buildAnimeByIdQuery(): string {
  return `
query AnimeById($id: Int!) {
  Media(id: $id) {
    ${MEDIA_FIELD_SELECTION}
  }
}
`.trim();
}

/** Batched metadata fetch for listed-media source repair (`id_in` + Page). */
export const MEDIA_BY_IDS_QUERY = `
query MediaByIds($mediaIds: [Int], $page: Int!, $perPage: Int!) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
    media(id_in: $mediaIds) {
      ${MEDIA_FIELD_SELECTION}
    }
  }
}
`.trim();

/** Total anime count for random page selection. */
export function buildAnimePageCountQuery(): string {
  return `
query AnimePageCount {
  Page(page: 1, perPage: 1) {
    pageInfo { total }
    media(type: ANIME) {
      id
    }
  }
}
`.trim();
}

/** One page of anime for random-from-API picker. */
export function buildAnimeBrowsePageQuery(): string {
  return `
query AnimeBrowsePage($page: Int!, $perPage: Int!) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
    media(type: ANIME, sort: POPULARITY_DESC) {
      ${MEDIA_FIELD_SELECTION}
    }
  }
}
`.trim();
}

export const FAVOURITE_STUDIOS_QUERY = `
query FavouriteStudiosPage($username: String!, $page: Int!, $perPage: Int!) {
  User(name: $username) {
    favourites {
      studios(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage currentPage }
        edges {
          favouriteOrder
          node {
            id
            name
          }
        }
      }
    }
  }
}
`.trim();

// ── Tools (live AniList queries ported from anilisttools) ─────────────

/** Top staff match by favourites for a name search (`compare_vas.py`). */
export const TOOLS_STAFF_SEARCH_QUERY = `
query ToolsStaffSearch($search: String!) {
  Staff(search: $search, sort: FAVOURITES_DESC) {
    id
    name { full }
  }
}
`.trim();

/** Resolve staff names for a set of ids (`compare_vas.py`). */
export const TOOLS_STAFF_BY_IDS_QUERY = `
query ToolsStaffByIds($staffIds: [Int], $page: Int!, $perPage: Int!) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
      staff(id_in: $staffIds) {
      id
      name { full native }
      image { large }
    }
  }
}
`.trim();

/** VA filmography edges for Shared Credits (`compare_vas.py`). */
export const TOOLS_STAFF_VOICE_ROLES_QUERY = `
query ToolsStaffVoiceRoles($id: Int!, $page: Int!, $perPage: Int!) {
  Staff(id: $id) {
    characterMedia(sort: START_DATE_DESC, page: $page, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        characterRole
        characters {
          id
          name { full native }
        }
        node {
          id
          title { english romaji }
          coverImage { large }
          startDate { year month day }
        }
      }
    }
  }
}
`.trim();

/** Production filmography edges for Shared Credits (`compare_vas.py`). */
export const TOOLS_STAFF_PRODUCTION_ROLES_QUERY = `
query ToolsStaffProductionRoles($id: Int!, $page: Int!, $perPage: Int!) {
  Staff(id: $id) {
    staffMedia(type: ANIME, sort: START_DATE_DESC, page: $page, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        staffRole
        node {
          id
          title { english romaji }
          coverImage { large }
          startDate { year month day }
        }
      }
    }
  }
}
`.trim();

/** User anime list for tools — includes `notes` for `#airing` filtering and
 * `MEDIA_ID` tie-break sort (`compare_vas.py` / `compare_seasons.py`).
 */
export const TOOLS_USER_ANIME_LIST_QUERY = `
query ToolsUserAnimeList(
  $userName: String
  $statusIn: [MediaListStatus]
  $page: Int!
  $perPage: Int!
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
    mediaList(
      userName: $userName
      type: ANIME
      status_in: $statusIn
      sort: [SCORE_DESC, MEDIA_ID]
    ) {
      mediaId
      status
      score(format: POINT_100)
      progress
      notes
      media {
        id
        title { english romaji native }
        coverImage { large }
        ${MEDIA_SOURCE_SELECTION}
        season
        seasonYear
        startDate { year month day }
        endDate { year month day }
        duration
      }
    }
  }
}
`.trim();

const WEEKLY_CALENDAR_MEDIA_FIELDS = `
  id
  title { english romaji native userPreferred }
  coverImage { large }
  ${MEDIA_STATUS_SELECTION}
  episodes
  popularity
  startDate { year month day }
  endDate { year month day }
  nextAiringEpisode { airingAt episode }
  airingSchedule(notYetAired: false, perPage: 24) {
    nodes { airingAt episode }
  }
`.trim();

/** Watching-list rows for Weekly Calendar — CURRENT/REPEATING with airing metadata. */
export const TOOLS_WEEKLY_CALENDAR_WATCHING_QUERY = `
query ToolsWeeklyCalendarWatching(
  $userName: String
  $statusIn: [MediaListStatus]
  $page: Int!
  $perPage: Int!
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
    mediaList(
      userName: $userName
      type: ANIME
      status_in: $statusIn
      sort: [MEDIA_ID]
    ) {
      status
      score(format: POINT_100)
      progress
      media {
        ${WEEKLY_CALENDAR_MEDIA_FIELDS}
      }
    }
  }
}
`.trim();

/** Season browse for Weekly Calendar — live airing/upcoming shows in one status bucket. */
export const TOOLS_WEEKLY_CALENDAR_SEASON_QUERY = `
query ToolsWeeklyCalendarSeason(
  $page: Int!
  $perPage: Int!
  $season: MediaSeason!
  $seasonYear: Int!
  $status: MediaStatus
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
    media(
      type: ANIME
      season: $season
      seasonYear: $seasonYear
      status: $status
      sort: [POPULARITY_DESC]
    ) {
      ${WEEKLY_CALENDAR_MEDIA_FIELDS}
    }
  }
}
`.trim();

/** Media search for Shared Staff show picker (`compare_staff.py`). */
export const TOOLS_MEDIA_SEARCH_QUERY = `
query ToolsMediaSearch($search: String!, $sort: [MediaSort]) {
  Media(search: $search, type: ANIME, sort: $sort) {
    id
    title { english romaji }
  }
}
`.trim();

/** Studios on a show (`compare_staff.py`). */
export const TOOLS_MEDIA_STUDIOS_QUERY = `
query ToolsMediaStudios($mediaId: Int!) {
  Media(id: $mediaId) {
    studios {
      edges {
        isMain
        node {
          id
          name
        }
      }
    }
  }
}
`.trim();

/** Production staff edges on a show (`compare_staff.py`). */
export const TOOLS_MEDIA_PRODUCTION_STAFF_QUERY = `
query ToolsMediaProductionStaff($mediaId: Int!, $page: Int!, $perPage: Int!) {
  Media(id: $mediaId) {
    staff(sort: RELEVANCE, page: $page, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        role
        node {
          id
          name { full native }
        }
      }
    }
  }
}
`.trim();

/** JP voice actors on a show (`compare_staff.py`). */
export const TOOLS_MEDIA_VOICE_ACTORS_QUERY = `
query ToolsMediaVoiceActors(
  $mediaId: Int!
  $language: StaffLanguage
  $page: Int!
  $perPage: Int!
) {
  Media(id: $mediaId) {
    characters(sort: [ROLE, RELEVANCE], page: $page, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        role
        node {
          id
          name { full native }
        }
        voiceActorRoles(language: $language) {
          roleNotes
          voiceActor {
            id
            name { full native }
          }
        }
      }
    }
  }
}
`.trim();

/** Production staff filmography for single-show Shared Staff search. */
export const TOOLS_STAFF_PRODUCTION_FILMOGRAPHY_QUERY = `
query ToolsStaffProductionFilmography(
  $staffId: Int!
  $page: Int!
  $perPage: Int!
) {
  Staff(id: $staffId) {
    staffMedia(type: ANIME, sort: POPULARITY_DESC, page: $page, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        staffRole
        node {
          id
          title { english romaji }
          coverImage { large }
        }
      }
    }
  }
}
`.trim();

/**
 * Chart/table metadata shared by Franchise + Adaptation relation fetches.
 */
export const TOOLS_MEDIA_CHART_METADATA_FIELDS = `
  id
  type
  format
  title { english romaji native }
  coverImage { large }
  startDate { year month day }
`.trim();

/** Nested relation edges for one media id (v2). Used in single + batched queries. */
export const TOOLS_MEDIA_RELATIONS_V2_NESTED_FIELDS = `
  relations {
    edges {
      ${TOOLS_MEDIA_RELATION_TYPE_FIELD}
      node {
        ${TOOLS_MEDIA_CHART_METADATA_FIELDS}
      }
    }
  }
`.trim();

/** Media + all v2 relation edges. Shared by Franchise and Adaptation tools. */
export const TOOLS_MEDIA_RELATIONS_V2_MEDIA_FIELDS = `
  ${TOOLS_MEDIA_CHART_METADATA_FIELDS}
  ${TOOLS_MEDIA_RELATIONS_V2_NESTED_FIELDS}
`.trim();

export const TOOLS_MEDIA_RELATIONS_V2_QUERY = `
query ToolsMediaRelationsV2($mediaId: Int!) {
  Media(id: $mediaId) {
    ${TOOLS_MEDIA_RELATIONS_V2_MEDIA_FIELDS}
  }
}
`.trim();

/** Related shows walk for Shared Staff (`compare_staff.py` parity). */
export const TOOLS_MEDIA_RELATIONS_QUERY = `
query ToolsMediaRelations($mediaId: Int!) {
  Media(id: $mediaId) {
    relations {
      edges {
        ${TOOLS_MEDIA_RELATION_TYPE_FIELD}
        node {
          id
          type
          format
          title { english romaji }
          tags { name }
        }
      }
    }
  }
}
`.trim();

/** @deprecated Use {@link TOOLS_MEDIA_RELATIONS_V2_QUERY} */
export const TOOLS_FRANCHISE_RELATIONS_QUERY = TOOLS_MEDIA_RELATIONS_V2_QUERY;

/** @deprecated Use {@link TOOLS_MEDIA_RELATIONS_V2_MEDIA_FIELDS} */
export const TOOLS_ADAPTATION_RELATIONS_MEDIA_FIELDS = TOOLS_MEDIA_RELATIONS_V2_MEDIA_FIELDS;

/** @deprecated Use {@link TOOLS_MEDIA_RELATIONS_V2_QUERY} */
export const TOOLS_ADAPTATION_RELATIONS_QUERY = TOOLS_MEDIA_RELATIONS_V2_QUERY;

/** User anime/manga list ids (non-planning) for Favourites consumed-media filter. */
export const TOOLS_USER_CONSUMED_MEDIA_QUERY = `
query ToolsUserConsumedMedia($userName: String, $page: Int!, $perPage: Int!, $type: MediaType!) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
    mediaList(
      userName: $userName
      type: $type
      status_not: PLANNING
      sort: [MEDIA_ID]
    ) {
      mediaId
    }
  }
}
`.trim();

/** Favourite characters with birthday for Favourites tool (`character_vas.py`). */
export const TOOLS_FAVOURITE_CHARACTERS_QUERY = `
query ToolsFavouriteCharacters($username: String!, $page: Int!, $perPage: Int!) {
  User(name: $username) {
    favourites {
      characters(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage currentPage }
        nodes {
          id
          name { full native alternative alternativeSpoiler }
          gender
          favourites
          dateOfBirth { year month day }
        }
      }
    }
  }
}
`.trim();

/** Favourite staff (VAs) for Favourites tool (`character_vas.py`). */
export const TOOLS_FAVOURITE_STAFF_QUERY = `
query ToolsFavouriteStaff($username: String!, $page: Int!, $perPage: Int!) {
  User(name: $username) {
    favourites {
      staff(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage currentPage }
        nodes {
          id
          name { full native }
          gender
          favourites
          image { large }
        }
      }
    }
  }
}
`.trim();

/** Character media edges with JP voice actors (`character_vas.py`). */
export const TOOLS_CHARACTER_VOICE_MEDIA_QUERY = `
query ToolsCharacterVoiceMedia($id: Int!, $page: Int!, $perPage: Int!) {
  Character(id: $id) {
    media(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        node {
          id
          title { romaji native english }
          synonyms
          type
          format
          coverImage { large }
        }
        characterRole
        voiceActors(language: JAPANESE, sort: RELEVANCE) {
          id
          name { full native }
          image { large }
          age
          gender
          languageV2
          favourites
        }
      }
    }
  }
}
`.trim();

/** Characters voiced by a staff member on consumed media (`character_vas.py`). */
export const TOOLS_VA_CHARACTER_MEDIA_QUERY = `
query ToolsVaCharacterMedia($id: Int!, $page: Int!, $perPage: Int!) {
  Staff(id: $id) {
    characterMedia(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        characterRole
        node { id }
        characters { id }
      }
    }
  }
}
`.trim();
