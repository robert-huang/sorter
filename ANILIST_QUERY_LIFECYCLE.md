# AniList query lifecycle

This inventory reflects the active code after the cache fixes in this change. “DB” means the persistent AniList SQLite/WASM source database. “Session” means an in-memory `Map` that is lost on reload. “LS” means `localStorage`.

## The cache misconception

- The commonly assumed **15-minute localStorage cache does not exist**. `TOOLS_SESSION_TTL_MS` is a 15-minute **in-memory** memo. Reloading the tab clears it.
- `withSessionMemo` is also in memory, but has **no TTL**; it lasts until reload or explicit bust.
- SQLite list and graph completion markers are the durable cache:
  - `last_full_refresh:<userId>:ANIME|MANGA`
  - `last_favourites_refresh:<userId>:<type>`
  - `media_cast_expansion`
  - `staff_filmography_expansion`
  - `character_media_expansion`
  - `media_relations_expansion`
- A normal DB-first run now trusts a completion marker even when the result contains zero rows. Before this change, several empty results were mistaken for misses and fetched repeatedly.
- LS is used by Weekly Calendar (7-day user-list snapshot, 90-day historical seasons) and Shared Staff’s related-anime walk (90 days). Old Franchise/Adaptation LS relation entries are migrated once into SQLite and deleted.
- AniList returns the complete selection set on every live page. There is no delta query: every field listed below is re-retrieved whenever that operation is sent, and pagination repeats `pageInfo` plus all node/edge fields on every page.

## Checkpoint and interruption contract

- Completed SQLite transactions survive reload/tab closure. An in-flight request and its not-yet-committed transaction do not.
- Shared entity data is checkpointed as soon as a bounded unit completes:
  - every `ListCollection` chunk;
  - every favourites page;
  - media cast in groups of 5;
  - character-media in groups of 8;
  - staff filmographies in groups of 5;
  - studio/media repairs in groups of 50;
  - media relations in groups of 15.
- Completion markers are written in the same transaction as their graph rows. On a normal retry, marker checks remove completed entities from the pending set. A failed batch fallback retries only the failed group/item, not earlier committed work.
- User-specific mutable collections are different. List membership, favourite ordering, and their final refresh markers are wipe-and-rebuild snapshots, so they commit only after all pages succeed. Shared entities from completed pages remain durable after a partial failure, but the previous complete user snapshot remains visible.
- A successful list/favourites run does not rewrite the shared entities again in its final user-specific transaction; page/chunk checkpoints are the single shared-data write path.
- Stats list rows remain session-only, but each fetched page completes its media/studio repair before the next page. Its cast progress reports committed cast groups, not subsequent DB reads.
- Shared Staff's related-anime BFS stores `related`, `visitedFetches`, and the remaining frontier in LS after each 15-media request. A retry resumes that frontier and deletes the work checkpoint only after the walk completes.
- Each completed ad-hoc DB checkpoint invokes the dirty-change hook after commit. These writes require a later manual cloud push; the final successful list/favourites snapshot can request auto-push.

## Shared field sets

**Full media metadata (`MEDIA_FIELD_SELECTION`)**: `id`, `type`, `title { english romaji native }`, `coverImage.large`, `format`, `source(version:3)`, `status(version:2)`, `episodes`, `chapters`, `startDate`, `endDate`, `season`, `seasonYear`, `meanScore`, `favourites`, `countryOfOrigin`, `genres`, `synonyms`, `studios.edges { isMain node { id name } }`, and `tags { name rank }`.

**Favourite media metadata**: the same fields except `studios` (AniList returns HTTP 500 for that selection on favourite media).

**Relation chart metadata**: `id`, `type`, `format`, titles, cover, and start date. Each edge also returns `relationType(version:3)`.

**Media cast expansion**:
- Character pages: role; character id, names, image, age, gender, favourites; selected-language VA id, names, language, image, age, gender, favourites.
- Staff pages: role; staff id, names, language, image, age, gender, favourites.
- Character and staff connections paginate independently.

**Staff filmography expansion**:
- Staff profile: id, names, language, image, age, gender, favourites.
- Character-media pages: `characterRole`; character identity/profile; media identity, titles, synonyms, type, format, cover, dates, season, status, episode/chapter counts, score/favourites, origin, genres, source.
- Staff-media pages: `staffRole` and the same media metadata.

## Tools: Shared Credits

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Compare** | For name inputs, `ToolsStaffSearch` once per name (`Staff.id`, `name.full`). `ToolsStaffByIds` resolves id/name/native/image. Missing staff graphs use batched staff-filmography operations. Optional username filter cold-loads `ResolveUser` + `ListCollection(ANIME)`. | Search/name results: session-only, no TTL. Filmographies and list: DB plus completion markers. | Nothing on a warm DB/session hit. On a live call, the full operation selection is repeated on every page. |
| Right-click **Compare** | Re-fetches staff names, all selected staff filmographies, and the optional user anime list. Name-to-id search itself has its own session memo and is not force-busted. | Replaces DB graph/list rows and markers; busts affected session name memo. | Full fields above. |
| Username **↻** | `ResolveUser` + `ListCollection(ANIME)`. | DB; busts tool session memos. | Entire list entry + full media selection. |

`ListCollection` fields: `hasNextChunk`; list name/custom/status; entry score/status/repeat/notes/start/completion dates/createdAt/updatedAt/custom lists; full media metadata. The direct `ToolsStaffVoiceRoles`, `ToolsStaffProductionRoles`, and `ToolsUserAnimeList` helpers remain as legacy emergency fallbacks, but completed DB markers—including completed empty results—prevent them in normal execution.

## Tools: Shared Staff

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Compare** | `ToolsMediaSearch` for each typed show (`id`, English/Romaji title). Missing cast uses batched media character/staff queries. Missing studio metadata is repaired with `MediaByIds`. | Searches: session-only, no TTL. Cast/studios: DB and completion timestamps. | Only missing graph pieces. Live pages repeat the full cast/studio fields. |
| Right-click **Compare** | Force-fetches cast and studio metadata for selected shows. Search text resolution remains session-memoized. | Replaces DB graph rows and markers. | Full cast and full media/studio selection. |
| Single-show scan | Optionally walks related anime using `ToolsMediaRelationsWalkBatch`: relation type and node `id/type/format/tags.name`; then expands each production staff member’s filmography. | Related-id set: session + LS, 90 days. The unfinished BFS frontier is checkpointed after each 15-media batch. Filmographies: DB in groups of 5. | Missing only; interrupted walks/filmography runs resume past completed checkpoints. Right-click busts LS/session relation state and forces filmographies. |
| Single-show top match | Expands cast and studios for the winning show if missing. | DB. | Same media cast/studio fields. |

The old standalone `ToolsMediaStudios`, `ToolsMediaProductionStaff`, `ToolsMediaVoiceActors`, and `ToolsStaffProductionFilmography` reads are retained as last-resort fallbacks. Successful DB expansion now represents valid empty maps, so zero studios/staff/VAs no longer causes repeat fallback calls.

## Tools: Seasonal Scores

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Compare** | Cold DB only: `ResolveUser` + `ListCollection(ANIME)`. Existing completed lists are read from DB, including linked OAuth accounts and empty lists. Old rows with unknown source may run `MediaByIds`. | List/media/source repair: DB. Result view: 15-minute session memo. | No list query on a completed DB hit. |
| Right-click **Compare** | Forces `ResolveUser` + `ListCollection(ANIME)`. | Replaces DB list/media rows and marker; busts session result. | Full list entry + full media metadata. |
| Username **↻** | Same forced anime import. | DB; explicitly busts Seasonal’s session memo. | Full list selection. |

This tool previously bypassed SQLite for linked accounts and ran `ToolsUserAnimeList`; that was the cause of normal periodic/reload refetches here. It is now DB-first.

## Tools: Franchise Scores

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Trace** | `ToolsMediaSearch` resolves the seed. BFS uses `ToolsMediaRelationsV2Batch` for relation markers that are missing. User stamps cold-load `ResolveUser` + `ListCollection` independently for ANIME and MANGA. | Seed search: session/no TTL. Relations, media stubs, lists: DB. | Missing relation seeds and missing list types only. |
| Right-click **Trace** | Forces every traversed relation seed and both list types. Seed search remains session-memoized. | Replaces DB relation/list data. | Relation chart metadata for every traversed node; full lists. |
| Username **↻** | Forced anime and manga imports where configured by shared username refresh. | DB; busts related session memo entries. | Full list fields. |

`ToolsMediaRelationsV2Batch` returns each root’s relation chart metadata plus all edge relation types and edge-node chart metadata. Every successful root is persisted with its marker before the next bounded group. If the batch request fails, the code retries its roots with `ToolsMediaRelationsV2`; if one root's persistence fails, only that unfinished root is retried.

## Tools: Adaptation Scores

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Compare** | Cold-loads `ResolveUser` + `ListCollection` for ANIME and MANGA; scans every list media id through missing `ToolsMediaRelationsV2Batch` markers. | Lists, relation graph, media stubs: DB. | Only missing list/relations. Filters and sort changes are local. |
| Right-click **Compare** | Forces both lists and all scanned relation roots. | Replaces DB rows/markers. | Full lists and relation chart fields. |
| Per-row relation refresh | Single `ToolsMediaRelationsV2`. | Replaces that media’s DB relation set and marker. | Full root + edges. |

Successful runs update `anilist:lastUsername`.

## Tools: Stats

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Run** | `ToolsStatsList` unless its 15-minute in-memory memo is warm. After each list page, missing studio metadata runs `MediaByIds` before pagination continues. STAFF/VA aggregations expand missing media cast in groups of 5. | Stats list response: session only, 15 minutes. Each page's media/studio repair and each cast group: DB checkpoint. | After reload or 15 minutes, the Stats list pages are fetched again, but completed reusable studio/cast markers avoid repeating downstream graph work. |
| Right-click **Run** | Forces Stats list, studios, and any required cast expansion. | Replaces session list and DB graph metadata. | All Stats fields and relevant graph fields. |
| **Expand all cast** | Missing media cast batch queries only. | DB cast junctions and markers. | Character/staff fields for missing media. |
| DB revision refresh after another expansion | No AniList request; `refreshStatsCastFromDb` rebuilds the chart from SQLite. | Session React state only. | None. |

`ToolsStatsList` fields: list status, normalized score, progress, progressVolumes, repeat, notes; media id/titles/cover/format/status/episodes/chapters/volumes/duration/meanScore/startDate. Stats intentionally needs fields not stored by the standard list importer, so its list snapshot is still live + session-only. This is the main remaining “Run refetches after reload/15m” tool.

## Tools: Weekly Calendar

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Load calendar**, Watching mode | `ToolsWeeklyCalendarWatching` only if 15-minute session and 7-day LS entries miss. | Session 15m + LS 7d. | List status/score/progress and full weekly media airing fields. |
| Left-click, season/range mode | User list map uses `ToolsUserAnimeList` on 7-day LS miss. Each season uses `ToolsWeeklyCalendarSeason`. Current/future seasons are session-only 15m; historical seasons also use LS 90d. | Session + LS as described; not SQLite. | Each live season repeats all weekly media fields. |
| Right-click **Load calendar** | Bypasses relevant session/LS entries and fetches current selection. | Overwrites LS TTL entries. | Entire watching/list/season selections. |
| Username **↻** | Busts watching and list-map session + LS keys. The next load fetches them. | Cache deletion; shared list refresh may separately update DB. | None until next Load. |
| **Fetch theme songs** / **Re-fetch theme songs** | For media missing a MAL id, `MediaIdMal` (`Media.id`, `idMal`); song lookup itself goes to AniPlaylist, not AniList. | MAL id and theme-song payload: DB. | `id/idMal` when needed or forced. |

Weekly media fields: id; English/Romaji/native/userPreferred titles; cover; format; status(v2); episodes; popularity; dates; next airing timestamp/episode; up to 24 past airing schedule nodes.

## Tools: Favourites

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Analyze** | Cold-loads anime/manga lists with `ResolveUser` + `ListCollection`; cold-loads `FavouriteCharactersPage` and `FavouriteStaffPage`; expands missing favourite-character media and VA/staff filmographies in batches. | Shared entities checkpoint per list chunk/favourite page. User membership/order and final markers commit atomically at completion. Character-media and staff-filmography checkpoints use groups of 8/5. Character/staff list views also have 15-minute session memos. | Missing markers only. Valid empty lists no longer refetch. |
| Right-click **Analyze** | Forces only favourite character and staff imports. Consumed anime/manga lists are not forced. Graph roles remain cache-first. | Replaces favourite DB tables/markers; busts favourite session memos. | Favourite character/staff fields only. |
| **Expand all roles** | Forces all favourite-character media and relevant staff filmographies, including favourite staff not already encountered as VAs. | Replaces DB graph data/markers. | Character-media and staff-filmography fields. |
| **Load more** / **Load all** | No request; reveals already-computed rows. | React state only. | None. |
| Username **↻** | Forces anime, manga, favourite characters, and favourite staff; busts Favourites session memos. | DB. | Full list + favourite fields. |

Favourite character fields: favourite order; id; full/native/alternative/spoiler names; image; age; gender; favourites; birthday. Favourite staff fields: favourite order; id; names; language; image; age; gender; favourites. Character-media expansion includes media identity/title/synonyms/type/format/cover, character role, and Japanese VA profile. The slim VA-total filmography returns media id, character role, and character ids.

The old `ToolsUserConsumedMedia`, `ToolsFavouriteCharacters`, and `ToolsFavouriteStaff` operations are no longer active in Analyze. They were replaced by shared DB imports.

## Tools: Reorder Favourites

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Load favourites** | Always `ResolveUser` then the selected favourite page query: anime, manga, characters, staff, or studios. | Shared entities checkpoint per page; selected user favourite order/table and marker replace atomically after all pages. | Complete selected favourite pages every click. A failed run keeps the previous user ordering but retains completed shared-entity checkpoints. |
| Right-click **Load favourites** | Same as left-click; Load is already always fresh. | Same. | Same. |
| **Save order** | `UpdateFavouriteOrder`, sending selected type ids + ascending order. Response requests `anime.pageInfo.total`. | Patches local DB `sort_order/fetched_at`. | Only mutation response fields. |
| **Delete selected** | One `ToggleFavourite` mutation per selected entity; response `__typename`. | Deletes those local favourite rows. | One mutation response per id. |

Favourite studio fields are order, id, and name. Favourite anime/manga use favourite order plus favourite media metadata.

## Tools: Update List Entry

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Left-click **Update** | If notes find/replace is used, `ListEntryForMedia` first; then one partial `SaveMediaListEntry`. | Patches existing local list status/score/notes when present; busts Seasonal’s session memo. Progress fields are not currently patched into SQLite. | Current entry id/notes/status/progress/progressVolumes/score when notes are read; mutation returns id plus only fields sent. |
| Right-click **Update** | No action. This mutation tool passes an empty force-refresh handler. | None. | None. |
| **Mass Update Notes**, first click | Confirmation only. | React state only. | None. |
| **Mass Update Notes**, confirm click | `ListNotesCollection` for ANIME and MANGA, all chunks; then one `SaveMediaListEntry(notes)` per changed entry. | Patches matching local notes rows and busts Seasonal memo. | Every media id + notes, then mutation id/notes per changed row. |

## Sorter

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| **Import Anime/Manga** | `ResolveUser`; `ListCollection` chunks until `hasNextChunk=false`. | Media/studio/tag rows checkpoint after every chunk. User/list/custom-list rows and the per-type marker replace atomically after all chunks. Successful full import requests cloud auto-push when cloud is ready. | Full list and media fields every import. After interruption, the user snapshot restarts from chunk 1 because mutable pagination is not safely resumable, but completed shared data is retained. |
| **Use cached list** | None. | Reads DB. | None. |
| **Refresh favourite type** | `ResolveUser`; selected `Favourite…Page` until complete. | Shared entities checkpoint per page; favourite rows/order + marker replace atomically at completion. Successful refresh requests cloud auto-push. | Complete selected favourite fields. Partial runs preserve the old favourite snapshot. |
| **Use cached favourites** | None. | Reads DB. | None. |
| Open media modal | Paints DB immediately; if cast marker is absent/incomplete, starts media cast expansion after paint. | DB cast/profile/junction rows and markers; increments pending cloud-change count. | Missing character/staff pages only. |
| Media modal **Refresh** | Forces cast and `MediaRelations`. | Replaces DB graph rows/markers; marks pending changes. | Full cast plus relation node metadata. |
| Media modal theme-song button | `MediaIdMal` when required; external AniPlaylist calls are not AniList GraphQL. | DB. | id/idMal. |
| Open staff modal | Paints DB; missing filmography starts `StaffFilmography` expansion. | DB. | Missing staff profile/filmography pages. |
| Staff modal **Refresh** | Forces staff filmography. | Replaces DB rows/marker. | Full filmography fields. |
| Filter bulk graph expansion | Missing media cast expansions only. | DB. | Full cast fields for selected candidates. |
| AniList account **Sign in** | OAuth exchange is external; then authenticated `Viewer { id name }`. | Account token/identity in local account storage, not source DB. | id/name on each completed sign-in. |

`anilist:lastUsername` is updated after every successful shared-runner anime-list, manga-list, or favourites import of any type, regardless of whether Sorter, A2A, or a Tools panel started it. Successful cache-only Start/A2A selections and Adaptation Scores runs also update it. Each Tools panel persists its own username separately, so this global value does not replace another tool’s field. Non-AniList imports do not update it.

## Anime-to-Anime (A2A)

| Trigger | AniList operations | Cache/write | Re-retrieved |
|---|---|---|---|
| Search text | `AnimeSearch` when API search is used: Page metadata + full media metadata. | Upserts media to DB. | Entire media selection per search. |
| **Load by ID** | `AnimeById`: full media metadata. | Upserts media to DB. | Full media selection. |
| **Random from cache** | None. | Reads DB. | None. |
| Left-click **Random from user list** | Uses DB if `last_full_refresh` exists, including a completed empty list. Otherwise `ResolveUser` + `ListCollection(ANIME)`. | DB. Successful selection updates `anilist:lastUsername`. | Full list only on cold marker. |
| Right-click **Random from user list** | Forces `ResolveUser` + `ListCollection(ANIME)`. | Replaces DB list and marker. | Full list fields. |
| **Random from AniList** | `AnimePageCount` (`pageInfo.total` and one media id), then `AnimeBrowsePage` with full metadata for 50 popular anime. | Selected media is upserted to DB. | Count + complete browse page on every click. |
| **Begin round** / normal hop | Missing current-media cast and relations, or missing selected-staff filmography, are expanded before presenting hops. | DB graph rows/markers. | Only missing graph fields. |
| Per-entry **Refetch this entry from AniList** | Forces current media cast/relations or current staff filmography, depending on entry kind. | Replaces DB graph rows/markers. | Full relevant graph fields. |
| Open media/staff detail from A2A | Same modal behavior as Sorter. | DB. | Missing only unless Refresh. |

## Repair and “background” behavior

There is **no periodic AniList crawler, no interval refresh, and no idle-time repair loop**. The following work is synchronous with a user action, except modal lazy expansion, which starts after the cached modal paints:

1. **Null-source repair**: old listed media with no authoritative `source_fetched_at` are grouped into `MediaByIds` requests (up to 50 ids). The full media selection is upserted, so source and other metadata are repaired together. Triggered after a newly required list import and by Seasonal Scores when it detects old rows.
2. **Studio-credit repair**: Stats and Shared Staff query `MediaByIds` for media whose `studios_fetched_at` marker is missing. It writes `media`, `studio`, `media_studio`, and a completion timestamp even for a valid empty studio list.
3. **Graph lazy expansion**: missing cast, character-media, staff-filmography, and relations markers trigger bounded AniList batches. Each entity's rows and marker commit together; retries skip completed entities and limit single-item fallback to the failed group. Data older than 90 days is shown as stale but is not normally refreshed unless the caller explicitly opts into stale refresh or the user force-refreshes.
4. **Migration 013 repair**: invalid/non-local graph completion markers are removed during migration. The next relevant user action re-expands those entities once; the migration itself sends no request.
5. **Legacy relation-cache migration**: old Franchise/Adaptation LS values are copied into SQLite once per session and the old LS keys are deleted. No AniList request is sent.
6. **Modal expansion**: media/staff modals read SQLite first, render it, then asynchronously fetch missing graph pages. This is the only UI behavior that looks like background AniList refresh.
7. **Cloud source DB sync**: successful full list/favourite imports request an automatic Drive push only when cloud is ready. Lazy graph/repair writes increment a pending-change counter and require **Push now**. Boot may pull a cloud DB only when no local DB is recorded. Push/pull/merge sends no AniList GraphQL.

## Busting each cache

- **SQLite list/favourites**: username **↻**, right-click tool Run/Compare/Trace where wired, Start-screen explicit import/refresh, or Reorder’s always-fresh Load.
- **SQLite graph**: right-click the tool run, modal Refresh, A2A per-entry Refetch, Favourites Expand all roles, or delete the source DB.
- **Session memo**: reload; explicit `sessionMemoDelete`; username **↻**; or force-refresh where the call passes `forceRefresh`.
- **Weekly LS**: right-click Load, username **↻** for list-derived keys, natural 7/90-day expiry, browser site-data clear, or source-key deletion.
- **Shared Staff related-anime LS**: right-click Compare, 90-day expiry, or browser site-data clear. This removes both the completed result and unfinished frontier checkpoint.
- **DB cloud copy**: Pull replaces/merges according to source DB sync rules; it is not a fetch from AniList.

## Why a Run can still make you wait

1. **Stats is intentionally live** after reload or its 15-minute in-memory TTL because standard SQLite list rows do not contain all Stats fields (`progress`, `progressVolumes`, `duration`, `volumes`).
2. **Weekly Calendar is its own LS cache**, not the shared SQLite list. Current-season data is only memoized in memory for 15 minutes; watching/list snapshots use 7-day LS.
3. **Graph expansion is lazy**. A cached user list does not imply every media/staff/character graph has been expanded, but an interrupted expansion does retain every completed bounded entity marker.
4. **A browser reload clears all session memos**, including search/name and Stats/Seasonal view memos.
5. Before this change, Favourites bypassed SQLite for linked accounts, Seasonal Scores did the same, A2A and Tools treated completed empty lists as misses, and empty graph maps fell into live fallback queries. Those paths were corrected at their completion-marker/DB-read source.
