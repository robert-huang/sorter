# Storage architecture

This inventory describes where the app stores data and why. For when data is refreshed or invalidated, see [AniList query lifecycle](./ANILIST_QUERY_LIFECYCLE.md).

## Short version

| Storage | Location | What belongs there |
|---|---|---|
| React state / in-memory maps | Current tab's memory | Render state, session memos, prepared Spotify matching indexes, and other data that can disappear on reload |
| `sessionStorage` | Current browser tab | Per-tab writer identity and temporary OAuth state |
| `localStorage` | Browser, shared by tabs on the same origin | Small settings, active IDs, migration/revision markers, OAuth credentials, tool forms, and a few TTL caches |
| IndexedDB | Browser, shared by tabs on the same origin | Sorter slot payloads/manifests, Bump Chart workspaces/manifests, Spotify playlist metadata, and reusable Spotify track-to-ISRC records |
| SQLite/WASM in OPFS | Browser's Origin Private File System | Durable AniList source data: media, lists, favourites, cast, staff, relations, theme songs, and completion markers |
| Google Drive | User's cloud account | Optional backups of sort slots and SQLite source database files |
| DynamoDB | Not used | There is no DynamoDB client, table, infrastructure, or data path in this repository |

All browser stores are origin-scoped. A deployment under a different scheme, hostname, or port gets different storage.

## DynamoDB

The app does **not** use DynamoDB. It is a browser application with optional Google Drive backup. Searches of the application and deployment code contain no DynamoDB SDK, table definition, or API that persists application data to DynamoDB.

If the hosting platform uses DynamoDB for something outside this repository, that is not part of the app's storage model and the browser code does not read or write it.

## IndexedDB

### What IndexedDB is

IndexedDB is the browser's asynchronous object database. Unlike `localStorage`, it can store structured JavaScript values instead of requiring one JSON string per key.

An IndexedDB database contains **object stores**, which are similar to key-value tables:

- Each record has a key.
- A write runs inside a transaction.
- The browser serializes values using the structured-clone algorithm.
- Reads and writes are asynchronous, so storage work does not use the synchronous `localStorage` API.
- Quota is browser-managed and normally much larger than the small fixed `localStorage` allowance, but it is not unlimited.
- Clearing site data removes it. We do not currently request persistent-storage protection with `navigator.storage.persist()`.

### Shared sorter and Bump Chart state

Database: `queue-sorter-state`
Schema version: `1`

| Object store | Record key | Stored value |
|---|---|---|
| `sorterSlots` | Sorter slot ID | Complete versioned sorter save: items, progress, and undo ring |
| `bumpWorkspaces` | `active` or named-chart ID | Active Bump Chart workspace or a named chart record |
| `metadata` | `sorterManifest`, `bumpManifest`, and migration records | Sorter and Bump Chart slot metadata needed to list and repair records |

`src/lib/stateStorageDb.ts` owns this database. Record-plus-manifest changes use one transaction, and sorter autosaves are serialized so an older async write cannot finish after a newer one. Named Bump Chart save, replacement, and deletion also update the payload and manifest atomically.

The database is hydrated into in-memory maps before consumers read it. Bump Chart autosave does not begin until hydration completes, preventing an empty initial React render from overwriting an existing workspace.

After each durable change, the writer updates the small `sorter:state-revision:v1` localStorage stamp. Other tabs use that event as a hint to reload the affected IndexedDB records. IndexedDB itself does not emit cross-tab storage events.

### Spotify cache database

Database: `queue-sorter-spotify`  
Schema version: `1`

| Object store | Record key | Stored value |
|---|---|---|
| `playlistCaches` | `playlistId` | One complete `SpotifyPlaylistCache`: fetch/revision metadata, catalog tracks, local tracks, IDs, linked IDs, ISRCs, titles, artists, album, duration, and playlist positions |
| `trackIsrcs` | `trackId` | One `{ trackId, isrc }` record used to reuse Spotify ISRC lookups |

`src/lib/spotify/spotifyPlaylistCacheDb.ts` owns the database and transactions.

### Playlist refresh write path

1. Spotify playlist pages are fetched until the terminal page.
2. The pages are converted into one cache record for the selected playlist.
3. An IndexedDB read/write transaction replaces that playlist's `playlistCaches` record.
4. Only after the transaction succeeds is the in-memory cache updated.
5. React subscribers are notified and the displayed fetched timestamp changes.

A failed durable write leaves the prior cache in memory and IndexedDB and surfaces an error. It cannot silently show a successful refresh with an unsaved result.

Right-clicking the Refresh button clears the `playlistCaches` object store, keeps the selected playlist ID in `localStorage`, and then fetches and writes the selected playlist again.

### Hydration and matching

Theme-song matching does **not** query IndexedDB once per song. At startup:

1. Playlist records are loaded from IndexedDB.
2. They are placed in an in-memory map keyed by playlist ID.
3. Existing synchronous matching code reads that map.
4. A playlist revision invalidates only the prepared indexes and row results affected by that change.

This keeps rendering and matching fast while IndexedDB handles cross-reload persistence.

### Sorter and Bump Chart migration from localStorage

The following large keys are migration-only:

- `sorter:v1`
- `sorter:slots:v1`
- `sorter:slot:<id>:v1`
- `sorter:slot:<id>:writer:v1`
- `tools:bump-chart:workspace:v1`
- `tools:bump-chart:saved-manifest:v1`
- `tools:bump-chart:saved:v1:<id>`

Startup parses legacy records, commits all valid payloads to IndexedDB, records an internal transaction marker, then writes the small schema/active-ID keys and removes the old large keys. If startup is interrupted after the transaction, the internal marker prevents stale localStorage data from overwriting the committed records; the next startup only finishes marker/cleanup work.

A blocked database upgrade is retried. If IndexedDB definitively cannot open, the app leaves every legacy key untouched, uses an in-memory store for the current tab, and displays a persistence warning. Durable writes that exhaust quota keep current tab state and surface the existing storage warning; sorter recovery still tries cache purge, undo trimming, and eligible inactive-slot eviction.

### Spotify migration from localStorage

These former `localStorage` records are migration-only:

- `spotify:playlist-cache:v1`
- `spotify:playlist-cache:v2`
- `spotify:track-isrc:v1`

On hydration, the app:

1. Reads and validates legacy data.
2. Reads IndexedDB.
3. Keeps the newest playlist revision when both stores contain the same playlist.
4. Writes legacy-only or newer records to IndexedDB.
5. Removes the legacy `localStorage` keys only after the IndexedDB writes succeed.

The small selected-playlist record, `spotify:playlist:v1`, remains in `localStorage`.

### Was IndexedDB used before this?

No application code explicitly used IndexedDB before the Spotify durable-cache change. The AniList database already used SQLite/WASM persisted as a file in OPFS, which is a different browser storage API.

## What the Spotify changes improved

The IndexedDB move primarily fixed **capacity, reliability, and write responsiveness**:

- The 4,184-item playlist no longer competes with sort slots, auth, settings, and tool caches for the small `localStorage` quota.
- A playlist write replaces one IndexedDB record instead of serializing and rewriting one JSON object containing every cached playlist.
- ISRC updates write keyed records rather than rewriting one ever-growing JSON map.
- IndexedDB writes are asynchronous; `localStorage` serialization and writes are synchronous.
- Old Spotify cache blobs are removed from `localStorage` after migration, freeing space for data that still belongs there.
- Autosave purges disposable `tools-cache:*` entries before trimming undo history or evicting a user sort slot.

The earlier matching optimizations are separate from the storage move:

- Playlist IDs and ISRCs are indexed once instead of rescanning every playlist item for every theme song.
- Metadata normalization is prepared once and title matches are narrowed to exact normalized-title candidates.
- Match results are cached per theme row.
- Playlist and per-media revisions invalidate only affected prepared data.
- Exact ID/linked-ID/ISRC matches still take precedence over metadata matches.

IndexedDB therefore prevents the cache-size failure and avoids synchronous giant-store rewrites. The in-memory indexes and result caches are what reduce repeated matching CPU work.

## SQLite/WASM in OPFS

The app's main source database is `anilist.sqlite`, opened by SQLite WASM in a worker and persisted in OPFS.

It stores:

- AniList users and media metadata
- Anime and manga list entries and custom-list membership
- Media, character, staff, and studio favourites
- Studios, tags, cast, voice actors, and production staff
- Staff filmographies and character-media appearances
- Media relations
- Theme-song payloads
- Completion and refresh markers used to distinguish a cached empty result from missing data

SQLite is used when the data is relational, queried in several ways, updated incrementally, or shared by Sorter, Anime to Anime, and Anime Tools.

OPFS stores the SQLite file locally. It does not send data to a server. If another tab owns the OPFS access-handle pool, a tab can temporarily use an in-memory SQLite fallback; that fallback is not safe to push as the canonical cloud database.

## localStorage

`localStorage` is synchronous, string-only, origin-wide, and usually has a small browser-defined quota. Every value must be serialized to a string. It is suitable for small records needed immediately during startup, but it is a poor fit for large or growing caches.

### Retained state coordination keys

| Key or prefix | Contents |
|---|---|
| `sorter:active-slot-id:v1` | Active sorter slot ID |
| `sorter:state-schema:v1` | Completed state-storage migration version |
| `sorter:state-revision:v1` | Small cross-tab reload hint written after durable transactions |
| `sorter:settings:v1` | Sorter settings |

Sorter and Bump Chart payloads and manifests do not remain in `localStorage`; the old keys are read only during migration.

### Authentication and cloud metadata

| Key or prefix | Contents |
|---|---|
| `anilist:accounts:v1` | AniList linked accounts and access tokens |
| `spotify:auth:v1` | Spotify access/refresh token and profile |
| `sorter:cloud:tokens:v1` | Google OAuth access/refresh token |
| `sorter:cloud:folder:v1` | Selected Google Drive folder |
| `sorter:db-sync:v1` | Per-source Drive file IDs, etags, push/pull timestamps, locks, and pending-change counts |

OAuth nonce, PKCE verifier, and return-location keys are temporary supporting records. Tokens in `localStorage` are readable by JavaScript on the origin, so preventing XSS remains important.

### Small preferences and selections

Examples include:

- `spotify:playlist:v1`
- `spotify:local-file-match:v1`
- `spotify:theme-song-display:v1`
- `anilist:lastUsername`
- theme and settings-tab selections
- active Anime Tools panel
- tool usernames, forms, and filters
- modal display preferences

These are small and cheap to read synchronously. Losing one generally resets a UI preference rather than losing fetched source data.

### TTL tool caches

`tools-cache:*` stores selected Weekly Calendar and Shared Staff results across reloads. Depending on the dataset, entries expire after 7 or 90 days. They are disposable: an autosave quota failure deletes them before any user sort data is trimmed or evicted.

See [AniList query lifecycle](./ANILIST_QUERY_LIFECYCLE.md) for the exact refresh and bust behavior.

## sessionStorage

`sessionStorage` is isolated to one tab and disappears when the tab session ends.

It stores:

- `sorter:state-writer-id:v1` for cross-tab revision attribution
- temporary OAuth nonce/PKCE state where a flow only needs it for the current tab

It is not used for durable caches.

## In-memory storage

In-memory maps and React state disappear on reload. They include:

- 15-minute tool session memos
- request deduplication maps
- hydrated Spotify playlist and ISRC snapshots
- prepared Spotify ID, ISRC, title, and artist indexes
- bounded per-theme-row match results
- current component state

This layer is fastest and is used to avoid repeatedly parsing, normalizing, or querying durable stores during rendering.

## Google Drive

Google Drive is the only remote persistence provider in this repository.

It can store:

- One `.sorter.json` file per cloud-enabled sort slot
- SQLite source database backups such as `anilist.sqlite`

Drive backup is optional. Local browser storage remains the working copy. Drive file IDs and synchronization metadata are stored locally so the app can perform optimistic conflict checks.

## Choosing a store

Use these rules for new data:

1. Use memory for derived data that is cheap to rebuild and only useful in the current tab.
2. Use `sessionStorage` for tiny tab-scoped coordination or temporary OAuth state.
3. Use `localStorage` only for small settings, credentials, selections, and startup metadata that require synchronous access.
4. Use IndexedDB for large browser-local object caches that do not need relational queries.
5. Use SQLite/OPFS for authoritative relational source data, completion markers, and data shared across application surfaces.
6. Use Google Drive only for explicit cross-device backup/sync.
7. Do not introduce DynamoDB unless the application gains a real backend and its ownership, authentication, retention, cost, and migration model are defined.

## Clearing behavior

| Action | Effect |
|---|---|
| Normal Spotify Refresh | Replaces only the selected playlist's IndexedDB record |
| Right-click Spotify Refresh | Clears every cached playlist, preserves selection, then refreshes that playlist |
| Spotify sign-out | Clears Spotify auth, selection, and durable playlist caches |
| Browser “clear site data” | Removes localStorage, IndexedDB, OPFS/SQLite, and other origin storage |
| Per-source SQLite removal | Not currently implemented; clearing all site data also removes the local SQLite file |
| Source-database Drive deletion | Not currently implemented in the app; deleting the file manually in Drive does not remove the local OPFS copy |

