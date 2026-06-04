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
 */
const MEDIA_FIELD_SELECTION = `
  id
  type
  title { english romaji native }
  coverImage { large }
  format
  status
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
            ${MEDIA_FIELD_SELECTION}
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
            ${MEDIA_FIELD_SELECTION}
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
 * Staff filmography — paginate `characters` (VA appearances) and
 * `staffMedia` (production credits) independently.
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
    characters(page: $charactersPage, perPage: $perPage) {
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
        media {
          ${MEDIA_FIELD_SELECTION}
        }
      }
    }
    staffMedia(page: $staffMediaPage, perPage: $perPage) {
      pageInfo { hasNextPage currentPage }
      edges {
        role
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
        relationType
        node {
          ${MEDIA_FIELD_SELECTION}
        }
      }
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
