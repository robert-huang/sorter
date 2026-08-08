# Browser Storage Health Audit

Audit date: 2026-08-07
Audited revision: `d6feee99cfe154bd4c9abbc870e219cfbd3b5cc7`

This document complements `STORAGE_ARCHITECTURE.md`. That document explains how
storage works; this one inventories retention and growth risks and proposes the
health controls the app should add.

## Executive summary

The app does not have one general `localStorage` problem. Most fixed settings
are small and safe. The health risk comes from a smaller set of dynamic caches,
large user-owned records, and stores that are fully copied into memory.

The highest-priority growth paths are:

1. Bump Chart export image URL metadata in `localStorage` has no count, age, or
   byte limit and rewrites the full mapping on every update.
2. Bump Chart image blobs in Cache Storage and the tab's blob `Map` have no
   eviction policy.
3. `tools-cache:*` records have TTLs but expired records are usually removed
   only when read, while live records have no count or byte limit.
4. Spotify playlist and track-to-ISRC IndexedDB stores grow monotonically and
   are fully hydrated into JavaScript objects.
5. Sorter slots and saved Bump Chart workspaces have count limits but no
   per-record byte limits and are all hydrated at startup.
6. AniList SQLite files can grow as imported and fetched entities accumulate,
   but there are no size diagnostics, cache-row garbage collection, or
   user-facing source removal.
7. Reorder Favourites stores full deleted snapshots in `sessionStorage` without
   an automatic age, count, or byte limit. The visible username/type can now be
   dismissed manually, but that does not bound untouched history.

The general fix is to define a retention contract for every store, distinguish
user data from disposable caches, centralize quota recovery, and make storage
usage observable. User-created data must not be silently evicted. Disposable
caches should always be the first data removed under pressure.

## Bump Chart image blob cache

### What it is used for

PNG export cannot safely draw arbitrary cross-origin `<img>` elements directly
onto a canvas. Doing so can taint the canvas, and some image hosts do not provide
usable CORS responses.

The export path therefore:

1. Resolves AniList entities to alternative MyAnimeList image URLs when MAL
   export images are enabled.
2. Fetches image bytes with CORS.
3. Converts each response to a `Blob`.
4. Decodes the blob with `createImageBitmap` or an object URL.
5. Draws the decoded image onto the export canvas.

`bumpChartMalExportImages.ts` persists the entity-to-image-URL mapping in:

- `queue-sorter:bump-mal-export-image-urls:v1`

`bumpChartImageCache.ts` stores fetched blobs in:

- Cache Storage: `queue-sorter-bump-chart-mal-export-images-v1`
- Tab memory: `memoryBlobCache`

The blob loader also caches non-AniList images passed through the same export
path, using the source URL as the default cache key.

### Is it necessary?

The fetch-and-decode step is necessary for reliable canvas export. Persistent
blob caching is not.

Without Cache Storage, PNG export still works while online. Images are fetched
again on a later export or are omitted if they cannot be fetched. The persistent
cache only improves repeat-export speed, lowers network traffic, and provides
some best-effort reuse after reload.

Recommendation: keep bounded persistent caching because repeated exports can
otherwise re-download many images, but treat it as disposable. If maintenance
cost becomes undesirable, changing it to a bounded session-only cache is safe
for correctness.

### Required eviction policy

Use all limits together and evict when any limit is exceeded:

- Persistent TTL: 90 days from the last successful use.
- Persistent count limit: 200 images.
- Persistent byte limit: 50 MiB.
- Per-image limit: 5 MiB; use the image for the current export but do not cache
  larger responses.
- Memory limit: 32 blobs or 16 MiB, whichever is reached first.
- Eviction order: expired entries first, then least recently used.

Store `cachedAt`, `lastUsedAt`, and `byteLength` in a small IndexedDB cache
metadata store. Access timestamps can be write-throttled so repeated canvas
draws do not cause excessive writes. The metadata is disposable and must be
removed when the corresponding Cache Storage entry is removed.

Run cleanup:

- after opening the cache, scheduled with idle work;
- after a successful insertion;
- when a cache write throws `QuotaExceededError`;
- when the user selects a new **Clear disposable caches** action.

On quota failure, remove expired entries, then the oldest 25% of remaining
entries, and retry the cache write once. A second failure should be ignored
because this cache is optional.

Also delete obsolete versioned cache namespaces. Incrementing the `-v1` name in
the future otherwise leaves the old namespace and all its blobs behind.

The MAL URL mapping should move out of one whole-object `localStorage` value
into the same cache-metadata IndexedDB database. Give it a 180-day TTL, a
2,000-entry limit, and a 512 KiB aggregate limit. Evicting a blob does not need
to evict its URL mapping: a valid mapping is cheap and allows the blob to be
fetched again.

## `localStorage` inventory

### Dynamic or payload-sensitive data

These records need health controls.

- `queue-sorter:bump-mal-export-image-urls:v1`
  - Entity-to-MAL-image URL object.
  - Unbounded key count and bytes.
  - Loaded and rewritten as one synchronous JSON object.
  - Move to bounded IndexedDB cache metadata as described above.

- `tools-cache:<dynamic-key>`
  - Shared TTL cache implemented by `toolsPersistentCache.ts`.
  - Active families include Weekly Calendar list maps, watching rows and
    historical seasons, plus Shared Staff related-anime results and traversal
    checkpoints.
  - Historical and relation records use 90-day TTLs; Weekly Calendar user-list
    snapshots use 7-day TTLs.
  - An expired record is deleted when that exact key is read. A global
    expired/corrupt sweep normally occurs only after a failed write.
  - Live entries have no count, aggregate byte, or per-record byte limit.
  - Move dynamic payload caches to IndexedDB. Until then, cap the prefix at
    200 records and 2 MiB total, skip persistence for records over 256 KiB,
    and sweep expired/corrupt records at startup and before insertion.

- `anime-tools-favourites-rank-limits`
  - Username-to-rank-limit object.
  - Adds a new property for every username and rewrites the whole object.
  - Keep only the 50 most recently used usernames and remove default/null
    values that do not change behavior.

- Shared Staff and Shared Credits form records
  - `anime-tools-shared-staff-form`
  - `anime-tools-shared-credits-form`
  - Fixed key count, but arbitrary text fields can create a large synchronous
    `localStorage` payload.
  - Apply per-field and serialized-payload limits. If a form is too large,
    continue to support the in-memory value but do not silently truncate it
    while persisting.

- `anilist:accounts:v1`
  - Array of linked AniList accounts and access tokens.
  - User-controlled account count with no explicit cap, although practical
    volume is low.
  - Do not auto-evict accounts. Add an explicit linked-account limit or removal
    UX if account count becomes a real product concern.

- `sorter:db-sync:v1`
  - Google Drive sync metadata keyed by registered source.
  - Small while the source registry is small, but its retention should be tied
    to source removal rather than allowed to retain removed source IDs.

### Small fixed settings and pointers

These have fixed key counts and small expected value shapes. They are low growth
risk, but should still be registered with schemas and maximum serialized sizes.

Core sorter and UI:

- `sorter:settings:v1`
- `sorter:active-slot-id:v1`
- `sorter:state-schema:v1`
- `sorter:state-revision:v1`
- `settings:lastTab`
- `sorter:tools:bump-chart:saved-expanded:v1`

AniList and tools:

- `anilist:lastUsername`
- `anilist:display-preferences:v1`
- `anilist:includeFormatInLabel`
- `anilist-detail-production-roles`
- `anime-tools:preferences:v1`
- `anime-tools-active-tool`
- `anime-tools:settings:lastTab`

Anime-to-Anime:

- `anime-to-anime-theme`
- `anime-to-anime:settings:lastTab`
- `anime-to-anime-va-image-mode`
- `anime-to-anime-staff-gender-filter`
- `anime-to-anime-round-config`

Spotify:

- `spotify:auth:v1`
- `spotify:playlist:v1`
- `spotify:local-file-match:v1`
- `spotify:theme-song-display:v1`
- `spotify:api-bans:v2`

Google Drive:

- `sorter:cloud:tokens:v1`
- `sorter:cloud:folder:v1`

### Fixed tool form and filter records

Most of these are fixed-key, small JSON records. They are not cumulative, but a
shared persistence helper should still validate their schemas and enforce a
reasonable serialized-size limit.

- `anime-tools-favourites-form`
- `anime-tools-shared-credits-form`
- `anime-tools-shared-staff-form`
- `anime-tools-seasonal-scores-form`
- `anime-tools-seasonal-scores-source-filters`
- `anime-tools-seasonal-scores-primary-filters`
- `anime-tools-franchise-scores-form`
- `anime-tools-franchise-scores-filters`
- `anime-tools-adaptation-scores-form`
- `anime-tools-adaptation-scores-filters`
- `anime-tools-stats-form`
- `anime-tools-stats-filters`
- `anime-tools-weekly-calendar-form`
- `anime-tools-update-list-entry-form`
- `anime-tools-reorder-favourites-form`

### Sensitive records

The AniList, Spotify, and Google OAuth records contain bearer credentials in
`localStorage`. This is a low-volume but high-impact security decision: any
successful same-origin script execution can read them.

Client-side encryption does not solve that threat if the decryption key is also
available to same-origin JavaScript. Long term, a backend-for-frontend using
HttpOnly cookies is the stronger design. If this remains a browser-only app,
keep token lifetime and scopes minimal, remove tokens reliably on logout or
expiry, use a restrictive Content Security Policy, and document the trade-off.

### Legacy and migration-only records

The IndexedDB migration reads and removes these legacy sorter and Bump Chart
records after a successful transaction:

- `sorter:v1`
- `sorter:slots:v1`
- `sorter:slot:<id>:v1`
- `sorter:slot:<id>:writer:v1`
- `tools:bump-chart:workspace:v1`
- `tools:bump-chart:saved-manifest:v1`
- `tools:bump-chart:saved:v1:<id>`

Spotify migrates these older payload caches to IndexedDB:

- `spotify:playlist-cache:v1`
- `spotify:playlist-cache:v2`
- `spotify:track-isrc:v1`

Other compatibility keys still read by current code include:

- `spotify:api-ban:v1`
- `link-game-round-config`
- `anime-tools-shared-credits-query`
- `anime-tools-shared-staff-query`
- `anime-tools-seasonal-scores-season-text`
- `tools-cache:franchise:relations:*`
- `tools-cache:adaptation:relations:*`
- `tools-cache:tools:relations:v2:*`

Every migration should delete its source key immediately after a validated
write to the replacement store. Compatibility readers should have a planned
sunset version so fixed legacy data does not remain indefinitely.

## `sessionStorage` inventory

OAuth and coordination values are small and naturally tab-scoped:

- AniList: `anilist:auth:return-url`,
  `anilist:oauth:pending-nonce`
- Spotify: `spotify:oauth:pending-nonce`, `spotify:pkce:verifier`
- Google: `sorter:cloud:pkce:v1`, `sorter:preAuthHash`
- State writer identity: `sorter:state-writer-id:v1`
- AniPlaylist anonymous token: `aniplaylist:algolia-user-token`

Nonce and PKCE values are removed after use. The AniList return URL has a
reader/removal path but no current writer was found; verify whether it is dead
and remove it if so.

`reorder-favourites-recently-deleted` is different. Each entry contains a full
favourites snapshot, including labels and image URLs, and each deletion prepends
another entry. It can fill the tab's storage quota.

The Recently deleted panel's dismiss action removes only buckets for its current
username and favourite type, preserving hidden buckets for other scopes. If the
rewrite fails, the previous history remains and the panel shows a warning. This
is useful manual cleanup but is not an automatic retention policy.

Recommended retention:

- 10 deletion buckets;
- 24-hour maximum age;
- 2 MiB aggregate serialized size;
- oldest-first eviction;
- graceful failure that leaves the current operation working even if the undo
  snapshot cannot be persisted.

## IndexedDB inventory

### `queue-sorter-state`

Object stores:

- `sorterSlots`
- `bumpWorkspaces`
- `metadata`

Sorter slots are limited to 50 and saved Bump Charts to 20. Those count limits
are useful, but the records themselves can contain large item arrays, imports,
and undo history. No per-record byte limit exists.

Both storage modules hydrate all saved payloads into memory:

- sorter records populate `slotBlobCache`;
- saved Bump workspaces populate `savedWorkspaceCache`.

Consequences:

- disk use can still grow substantially despite slot limits;
- startup read and structured-clone cost scale with all saved data;
- tab memory duplicates much of IndexedDB;
- one abnormally large record can cause memory and quota failures.

Recommended changes:

1. Hydrate only manifests and the active record at startup.
2. Load named slots and charts by key when opened.
3. Keep a small memory LRU for recently opened records.
4. Measure serialized payload size before writes.
5. Start with a warning at 5 MiB and an explicit hard rejection at 20 MiB per
   saved record, then adjust from observed real payloads.
6. Do not silently evict named user data to satisfy an aggregate budget.

Bump Chart manifest repair currently removes manifest entries whose record is
missing, but records absent from the manifest remain in IndexedDB and memory.
New record envelopes should include name and write timestamps so interrupted
writes can be recovered deterministically. Existing orphans should be exposed
as recoverable records or removed only through an explicit cleanup action.

Sorter quota recovery currently purges `tools-cache:*`, trims active undo
history, then removes the oldest unpinned non-active slot. Purging
`localStorage` is not a reliable or substantial way to recover space for an
IndexedDB failure. The shared origin's disposable Cache Storage and Spotify
IndexedDB data should be considered before any saved sorter slot.

### `queue-sorter-spotify`

Object stores:

- `playlistCaches`, keyed by playlist ID
- `trackIsrcs`, keyed by track ID

Every playlist cache and track-to-ISRC record is read into memory on hydration.
Neither store has a count limit, byte limit, age-based sweep, or record-level
eviction API.

Recommended playlist policy:

- always retain the currently selected playlist;
- retain at most 20 other recently used playlists;
- expire non-selected playlists after 180 days;
- cap cached playlist payloads at 50 MiB total;
- load the selected/recent records by key rather than calling `readAll()`.

Recommended track-to-ISRC policy:

- add `lastUsedAt` metadata;
- expire unused mappings after 365 days;
- cap at 50,000 records or 25 MiB;
- read mappings for requested track IDs rather than hydrating the whole store;
- include the store in **Clear Spotify cached data**.

Both stores are disposable caches. Losing them should cause a refetch, not loss
of user-created app state.

## Cache Storage inventory

The only application-owned Cache Storage namespace found is:

- `queue-sorter-bump-chart-mal-export-images-v1`

It has no TTL, LRU metadata, count cap, byte cap, per-response cap, version
cleanup, quota retry, or user-facing clear operation. Corrupt entries are
deleted only when decode fails. Apply the Bump Chart eviction policy above.

## OPFS and SQLite inventory

The database worker keeps one SQLite/WASM database per registered source in
OPFS. AniList databases contain durable imported user data plus fetched media,
favourites, cast, staff, relations, theme songs, and completion metadata.

This is expected to be the largest legitimate data store. It must not use the
same automatic eviction rules as disposable caches.

Current health gaps:

- no source database size or row-count diagnostics;
- no general age or reachability cleanup for cache-derived rows;
- no user-facing **Remove this source's local data** operation;
- sync metadata can outlive a removed source;
- no explicit storage-pressure policy;
- deleting rows would not necessarily return file bytes without compaction.

Recommended controls:

1. Add worker diagnostics using SQLite `page_count`, `page_size`, and
   `freelist_count`, plus useful table row counts.
2. Distinguish imported/user-rooted rows from refetchable enrichment rows.
3. Garbage-collect only unreferenced or stale refetchable rows automatically.
4. Preserve imported user data unless the user explicitly removes the source.
5. Compact with `VACUUM` only as an explicit/idle maintenance operation after
   meaningful deletion, and test browser support and blocking cost first.
6. Implement source removal that deletes the OPFS file, local sync manifest
   entry, and in-memory worker handle. Ask separately whether the corresponding
   Google Drive backup should also be trashed.

## In-memory cache inventory

Tab memory is not part of browser quota, but unbounded maps can still make a
long-running tab slow or crash.

High-priority memory caches:

- `bumpChartImageCache.ts`
  - `memoryBlobCache` is unbounded by count and blob bytes.
  - Bound it to 32 blobs or 16 MiB with LRU eviction.
  - `pendingBlobLoads` removes settled promises and is not a retention issue.

- `toolsSessionMemo.ts`
  - `store` retains every successful `withSessionMemo` key until reload.
  - `ttlStore` removes an expired entry only when that key is accessed.
  - Add a 500-entry shared LRU and periodic expired sweep. Individual callers
    with larger payloads should use smaller owner-specific budgets.
  - `inflight` removes settled promises and is not a retention issue.

- `spotifyPlaylistMatch.ts`
  - Match results are capped at 10,000 and playlist indexes at four.
  - `mediaMatchRevisions` is not capped and grows for every invalidated media
    ID. Remove obsolete IDs or cap it with the same lifecycle as result entries.

- Sorter, Bump Chart, Spotify playlist, and Spotify ISRC mirrors
  - These fully duplicate persistent stores.
  - Replace full hydration with keyed reads and bounded recent-record LRUs.

The SQLite worker's open-database map is source-ID keyed. Its practical growth
is limited by the registered source list, but source removal must close and
delete the corresponding entry.

## Google Drive inventory

Google Drive is optional remote user storage, so local quota policies do not
apply directly.

Sorter slots can be created, updated, and moved to trash. `listCloudSlots()`
requests at most 1,000 files but does not paginate, so older slots become
invisible if the folder ever crosses that threshold. Add pagination and display
remote count/last-updated diagnostics.

SQLite backup uses one named file per source and updates the existing file when
found. There is no source-database delete operation parallel to sorter slot
deletion. Add one as part of source-removal UX, with explicit confirmation
because remote deletion is user-data deletion.

Never auto-evict Google Drive user data. Detect duplicate/orphan files and offer
an explicit cleanup action.

## Storage health design

### 1. Register every store

Create one storage catalog describing:

- owner and code location;
- backing store and key/prefix/database;
- category: user data, settings, credential, disposable cache, migration, or
  transient memory;
- schema/version;
- expected and maximum item size;
- TTL, count, and byte policy;
- whether it may be auto-evicted;
- clear/migrate/diagnose functions;
- behavior when unavailable or over quota;
- sensitivity.

New persistent storage should not be added without a catalog entry and a
retention decision. A test can compare registered `localStorage` key constants,
known IndexedDB stores, and Cache Storage namespaces with the catalog.

### 2. Centralize storage diagnostics

Add a Storage section to Settings showing:

- `navigator.storage.estimate()` usage, quota, and percentage;
- whether `navigator.storage.persisted()` is true;
- estimated `localStorage` bytes grouped by registered owner;
- IndexedDB record counts and owner-estimated bytes;
- Cache Storage response count and blob bytes;
- SQLite file/page usage and useful row counts;
- last cleanup result and last quota error.

Use 70% of reported origin quota as a warning and 85% as critical. These are
health signals, not permission to delete user data.

### 3. Centralize disposable-cache cleanup

Provide:

- **Clear image cache**
- **Clear tools/API caches**
- **Clear Spotify cached data**
- **Clear all disposable caches**
- **Remove local source data**

Cleanup must be idempotent and safe with multiple tabs. A failed cleanup in one
cache should not prevent attempts on the remaining caches.

### 4. Use one quota-recovery order

For writes of user-owned data:

1. Attempt the write.
2. On a confirmed quota error, delete expired/corrupt disposable entries.
3. Evict bounded image, tools, and Spotify caches.
4. Retry the original write once.
5. If it still fails, preserve the previous user data and show storage
   diagnostics plus explicit cleanup choices.

Undo history may be trimmed if it is clearly documented as disposable. Named
sorter slots, named Bump Charts, imported source data, and cloud backups must
not be silently deleted as generic quota recovery.

For writes to disposable caches, evict within that cache and retry once. If the
retry fails, skip persistence and continue.

### 5. Request durable storage deliberately

`navigator.storage.persist()` can reduce browser-initiated eviction of
IndexedDB and OPFS data, but it does not increase quota and does not replace
retention policies.

Offer **Keep local data on this device** after a meaningful user import or save,
show the granted/denied status, and keep the app functional if unavailable.
Do not request persistence merely to protect refetchable caches.

### 6. Separate capability checks

Some current comments and availability checks still describe sorter payloads
as `localStorage` data even though the primary store is IndexedDB. Use separate
capability reporting for Web Storage, IndexedDB, Cache Storage, and OPFS so a
failure in one does not incorrectly disable another.

## Prioritized implementation plan

### P0: prevent near-term unbounded growth

1. Add bounds and automatic eviction to the Bump Chart memory and Cache Storage
   blob caches, including stale cache-namespace deletion and quota retry.
2. Move the Bump MAL URL map to bounded IndexedDB metadata.
3. Add proactive expiry, count, aggregate-byte, and per-record limits to
   `tools-cache:*`; then migrate dynamic API payloads out of `localStorage`.
4. Bound Reorder Favourites deleted snapshots and the favourites rank-limit
   username map.
5. Create shared disposable-cache clear functions and use them before any
   user-data eviction during quota recovery.

### P1: control persistent data and memory amplification

1. Add Spotify TTL/count/byte policies and record-level delete/read operations.
2. Replace full IndexedDB hydration for sorter, Bump Chart, Spotify playlists,
   and ISRC mappings with keyed reads and bounded memory LRUs.
3. Measure sorter and Bump Chart record sizes; add warning and hard per-record
   limits with clear errors.
4. Add storage diagnostics and user-facing cache controls.
5. Add deliberate persistent-storage opt-in for user-owned IndexedDB/OPFS data.
6. Audit OAuth token persistence as a separate security task.

### P2: maintain large and remote stores

1. Add SQLite size/row diagnostics and refetchable-row garbage collection.
2. Implement complete local source removal and optional remote backup removal.
3. Add Google Drive pagination and duplicate/orphan cleanup UX.
4. Remove expired compatibility readers and stale comments after migration
   support windows close.

## Verification requirements

Add automated coverage for:

- TTL expiry without requiring a read of the same key;
- count and byte limits independently;
- least-recently-used ordering;
- oversized entries being used without being persisted;
- quota failure, eviction, one retry, and graceful fallback;
- obsolete Cache Storage namespace removal;
- cleanup preserving named sorter slots, named Bump Charts, active source data,
  auth records, and settings;
- multi-tab cleanup and revision behavior;
- lazy hydration reading only active/requested records;
- corrupt record cleanup;
- Bump Chart orphan detection and recovery;
- source removal closing the worker database and deleting all selected local
  metadata;
- Google Drive pagination beyond 1,000 results.

Browser-level tests should exercise actual IndexedDB and Cache Storage behavior;
unit tests alone will not expose all quota, transaction, and structured-clone
failure modes.

## Definition of healthy storage

The storage model is healthy when:

- every persistent store has an owner and retention contract;
- every disposable cache has TTL plus count/byte bounds;
- no whole-store hydration grows linearly without a memory cap;
- quota recovery evicts disposable data before user data;
- users can inspect usage and clear each cache category;
- large user records fail explicitly rather than corrupting or replacing prior
  data;
- local source data and remote backups have complete removal workflows;
- auth-token risk is documented and reviewed separately from storage volume;
- obsolete migrations and cache namespaces are eventually deleted.
