-- AniList source schema, v1. See
-- ~/.cursor/plans/sorter-anilist-integration_a3c8e1b2.plan.md §B for the
-- spec this file implements.
--
-- Notes for readers:
--   * `_meta` is created (CREATE IF NOT EXISTS) by the migration runner
--     itself (src/lib/db/migration-runner.ts → ensureMetaTable). Don't
--     CREATE it here — duplicate-table inside the migration transaction
--     would abort the whole migration.
--   * FK enforcement is per-connection in SQLite (`PRAGMA foreign_keys` is
--     not stored in the file). worker.ts + dbBytes.ts set it on every
--     connection open; a `PRAGMA foreign_keys = ON` inside this migration
--     transaction would be a no-op (SQLite ignores the pragma while a
--     transaction is open), so it's intentionally absent.
--   * Tables are ordered parent-before-child so every FK reference is to a
--     table that already exists. SQLite would also accept forward refs at
--     CREATE TABLE time, but parent-first ordering matches the same order
--     the importer needs to upsert in (parents before junctions/favs).

----------------------------------------------------------------------
-- User identity (one row per AniList user whose list/favourites we cache)
----------------------------------------------------------------------

-- Every row in the per-user tables (media_list_entry, *_favourite,
-- custom_list, …) is keyed to one of these. There is no concept of an
-- "active" / "primary" / "owner" user — every user is just a user, and
-- the importer takes `username` as a required parameter so a friend's
-- list can be imported and sorted alongside your own. The DB is also
-- shareable: sending the file to a friend lets them inherit every
-- user's catalogue + cache.
--
-- AniList's User.id is stable; User.name is mutable (rename allowed
-- once per N months) — PK on id, refresh name on every import.
CREATE TABLE anilist_user (
  id              INTEGER PRIMARY KEY,        -- AniList User.id, stable
  name            TEXT NOT NULL UNIQUE,       -- AniList User.name, mutable
  fetched_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

----------------------------------------------------------------------
-- Source-owned metadata (one row per AniList entity, merged row-wise)
----------------------------------------------------------------------

-- Media metadata (one row per AniList media id).
-- updated_at vs fetched_at: fetched_at bumped on every re-fetch (touched);
-- updated_at bumped only when content actually changes. Merge keys on
-- fetched_at since the importer upserts both together in practice.
CREATE TABLE media (
  id              INTEGER PRIMARY KEY,        -- AniList media id
  type            TEXT NOT NULL,              -- 'ANIME' | 'MANGA'
  title_english   TEXT,
  title_romaji    TEXT,
  title_native    TEXT,
  cover_image     TEXT,                       -- coverImage.large URL
  format          TEXT,
  status          TEXT,
  episodes        INTEGER,
  chapters        INTEGER,
  start_year      INTEGER,
  start_month     INTEGER,
  start_day       INTEGER,
  end_year        INTEGER,                    -- endDate.year (broadcast end / serialization end)
  end_month       INTEGER,
  end_day         INTEGER,
  season          TEXT,                       -- 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL'
  season_year     INTEGER,
  mean_score      INTEGER,                    -- AniList 0–100
  favourites      INTEGER,
  country_of_origin TEXT,                     -- ISO 3166-1 alpha-2 ('JP' | 'KR' | 'CN' | 'TW' | …); distinguishes anime/donghua/aeni
  genres_json     TEXT,                       -- JSON array of genre strings; small fixed set so denormalized is fine
  synonyms_json   TEXT,                       -- JSON array of alternative titles (SnK, AoT, …); used for title-search fallback
  fetched_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX media_season ON media(season_year, season);
CREATE INDEX media_format ON media(format);
CREATE INDEX media_status ON media(status);
CREATE INDEX media_mean_score ON media(mean_score);
CREATE INDEX media_country ON media(country_of_origin);

-- Studios (deduped across all media)
CREATE TABLE studio (
  id              INTEGER PRIMARY KEY,        -- AniList studio id
  name            TEXT NOT NULL,
  fetched_at      INTEGER NOT NULL
);

-- Tags (deduped across all media — AniList tag names are stable enough to treat as natural key)
CREATE TABLE tag (
  name            TEXT PRIMARY KEY,           -- AniList tag.name; case-sensitive
  fetched_at      INTEGER NOT NULL
);

-- Character (lazy, only fetched on detail-view).
-- name_alternatives_json: non-spoiler aliases (nicknames, romanization
-- variants, …). Used for title-search fallback in the detail panel.
-- name_alternatives_spoiler_json: post-twist names / secret identities;
-- store unconditionally, gate display behind a per-user "show spoilers"
-- toggle in the UI. Search matches against both — typing a spoiler
-- alias implies the user already knows it.
CREATE TABLE character (
  id              INTEGER PRIMARY KEY,
  name_full       TEXT,
  name_native     TEXT,
  name_alternatives_json         TEXT,        -- JSON array of strings; null if AniList returned no aliases
  name_alternatives_spoiler_json TEXT,        -- JSON array of strings; spoiler-gated by UI, not by storage
  image           TEXT,
  age             TEXT,                       -- AniList returns string ("17", "16-18", "Unknown")
  gender          TEXT,
  favourites      INTEGER,
  fetched_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX character_favourites ON character(favourites DESC);

-- Staff (lazy).
-- language_v2 is AniList's `Staff.languageV2` (free-form string,
-- "Japanese" | "English" | "Korean" | …). NOT the same enum as
-- `StaffLanguage` (uppercase JAPANESE) used by `voiceActors(language:)`.
-- Lets the UI badge a VA's primary language without joining back
-- through character_voice_actor; also useful for non-VA staff
-- (directors, writers) where the VA-language inference doesn't apply.
CREATE TABLE staff (
  id              INTEGER PRIMARY KEY,
  name_full       TEXT,
  name_native     TEXT,
  image           TEXT,
  age             TEXT,
  gender          TEXT,
  language_v2     TEXT,                       -- AniList Staff.languageV2; nullable when source omits it
  favourites      INTEGER,
  fetched_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX staff_favourites ON staff(favourites DESC);
CREATE INDEX staff_language ON staff(language_v2);

----------------------------------------------------------------------
-- Junctions (rebuilt transactionally per parent on each refresh)
----------------------------------------------------------------------

-- Media ↔ studio join (no rank — AniList returns ordered list; preserve via sort_order)
CREATE TABLE media_studio (
  media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  studio_id       INTEGER NOT NULL REFERENCES studio(id),
  sort_order      INTEGER NOT NULL,           -- 0-based position in studios.nodes
  PRIMARY KEY (media_id, studio_id)
);
CREATE INDEX idx_media_studio_studio ON media_studio(studio_id);

-- Media ↔ tag join with per-media rank (rank is 0–100, indicates relevance)
CREATE TABLE media_tag (
  media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag_name        TEXT NOT NULL REFERENCES tag(name),
  rank            INTEGER NOT NULL,
  PRIMARY KEY (media_id, tag_name)
);
CREATE INDEX idx_media_tag_tag ON media_tag(tag_name);
CREATE INDEX idx_media_tag_rank ON media_tag(media_id, rank DESC);

-- Media ↔ character (lazy, populated when user opens media detail).
-- Rebuilt transactionally on every detail refresh (DELETE WHERE media_id = ?;
-- INSERT new rows). CASCADE drops character_voice_actor rows when the
-- junction row goes away.
CREATE TABLE media_character (
  media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  character_id    INTEGER NOT NULL REFERENCES character(id),
  role            TEXT,                       -- 'MAIN' | 'SUPPORTING' | 'BACKGROUND'
  sort_order      INTEGER NOT NULL,
  PRIMARY KEY (media_id, character_id)
);
CREATE INDEX idx_media_character_character ON media_character(character_id);

-- Character ↔ voice actor (staff).
-- v1 default = JAPANESE. The importer derives BOTH the GraphQL
-- `voiceActors(language: …)` filter AND this column's row value from a
-- single `voiceActorLanguage` parameter (see lazyExpansion.ts +
-- queries.ts#buildMediaDetailQuery), so the column value cannot drift
-- from what AniList actually returned. Language is kept in the PK so
-- adding ENGLISH or other languages later is an importer-only change
-- (no schema migration) and multi-language refresh slots in cleanly.
CREATE TABLE character_voice_actor (
  media_id        INTEGER NOT NULL,
  character_id    INTEGER NOT NULL,
  staff_id        INTEGER NOT NULL REFERENCES staff(id),
  language        TEXT NOT NULL,              -- 'JAPANESE' | 'ENGLISH' | 'KOREAN' | 'CHINESE' | … (v1 default = 'JAPANESE')
  PRIMARY KEY (media_id, character_id, staff_id, language),
  FOREIGN KEY (media_id, character_id) REFERENCES media_character(media_id, character_id) ON DELETE CASCADE
);

----------------------------------------------------------------------
-- User-data tables (sourced from AniList; merge row-wise on updated_at)
----------------------------------------------------------------------

-- User list entry (one row per (anilist_user, media)).
-- score is normalized server-side via GraphQL score(format: POINT_100); 0 means
-- "not rated" by AniList convention — render as blank, not "0".
--
-- updated_at / fetched_at are LOCAL DB-row timestamps (set by the
-- importer's now()). The AniList-server-side timestamps live in
-- anilist_created_at / anilist_updated_at and are what you want for
-- filters like "entries I added this month" or "entries I rescored
-- this week" (AniList bumps MediaList.updatedAt on every modification
-- including creation, and exposes MediaList.createdAt for first-touch
-- only). Stored in MS (server returns seconds; importer multiplies).
CREATE TABLE media_list_entry (
  anilist_user_id      INTEGER NOT NULL REFERENCES anilist_user(id) ON DELETE CASCADE,
  media_id             INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  score                INTEGER,               -- 0–100; 0 = not rated
  status               TEXT NOT NULL,         -- 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'REPEATING'
  repeat               INTEGER,               -- AniList MediaList.repeat: rewatch/reread count; nullable for not-yet-set
  started_year         INTEGER,
  started_month        INTEGER,
  started_day          INTEGER,
  completed_year       INTEGER,
  completed_month      INTEGER,
  completed_day        INTEGER,
  anilist_created_at   INTEGER,               -- MS since epoch; AniList MediaList.createdAt × 1000. Nullable: pre-feature entries on AniList may lack it.
  anilist_updated_at   INTEGER,               -- MS since epoch; AniList MediaList.updatedAt × 1000. Nullable: same caveat.
  fetched_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (anilist_user_id, media_id)
);
CREATE INDEX media_list_status ON media_list_entry(status);
CREATE INDEX media_list_score ON media_list_entry(score DESC);
CREATE INDEX media_list_user ON media_list_entry(anilist_user_id);
CREATE INDEX media_list_anilist_updated ON media_list_entry(anilist_updated_at DESC);

----------------------------------------------------------------------
-- Custom lists (AniList "Best of 2023" / "Currently Watching Together")
----------------------------------------------------------------------

-- One row per (user, name, media_type). Per-media-type separation
-- matches AniList's server-side model: a user can define "Top 2023"
-- for ANIME and a separate "Top 2023" for MANGA, and they're distinct
-- buckets even though they share a name. Each shows up as its own
-- filter chip; mixing is opt-in via the UI.
--
-- Natural-key PK (no autoincrement id) so the importer can insert
-- lists and memberships in the same execBatch without a round-trip
-- SELECT to learn assigned IDs. Storage cost is negligible (a name
-- TEXT in each membership row instead of an INTEGER), and orphan
-- cleanup stays simple — DELETE WHERE NOT EXISTS (… membership …).
CREATE TABLE custom_list (
  anilist_user_id INTEGER NOT NULL REFERENCES anilist_user(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,              -- user-chosen, mutable on AniList; renames orphan the old row (GC'd post-import)
  media_type      TEXT NOT NULL,              -- 'ANIME' | 'MANGA'; scopes the list to one type per AniList's model
  fetched_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (anilist_user_id, name, media_type)
);

-- Membership: which list entries belong to which custom list.
-- Composite FK on (anilist_user_id, media_id) → media_list_entry
-- cascades memberships away on entry deletion, so the importer's wipe
-- of media_list_entry per (user, type) on each import auto-clears
-- stale memberships without needing a separate DELETE.
--
-- media_type is denormalised here only so the FK back to custom_list
-- can be composite — it MUST equal media.type for media_id but we
-- don't add a trigger to enforce that (importer is the only writer
-- and never violates it). FK to custom_list does NOT cascade because
-- entry wipe handles deletion; we only want custom_list rows to be
-- dropped when explicitly GC'd post-import.
CREATE TABLE media_custom_list_membership (
  anilist_user_id  INTEGER NOT NULL,
  media_id         INTEGER NOT NULL,
  custom_list_name TEXT NOT NULL,
  media_type       TEXT NOT NULL,
  PRIMARY KEY (anilist_user_id, media_id, custom_list_name, media_type),
  FOREIGN KEY (anilist_user_id, media_id)
    REFERENCES media_list_entry(anilist_user_id, media_id) ON DELETE CASCADE,
  FOREIGN KEY (anilist_user_id, custom_list_name, media_type)
    REFERENCES custom_list(anilist_user_id, name, media_type)
);
CREATE INDEX idx_mclm_list ON media_custom_list_membership(anilist_user_id, custom_list_name, media_type);

----------------------------------------------------------------------
-- Favourites (per-(user, type) wipe-and-rebuild on user-triggered refresh)
----------------------------------------------------------------------
-- All four favourite tables are keyed on (anilist_user_id, <entity>_id)
-- so multiple users' favourites coexist in one DB. fetched_at is
-- diagnostic; merge is wipe-and-rebuild per (user, type) — row-level
-- merge would resurrect favourites the user explicitly removed.

-- User's favourite media (anime + manga; type lives on media.type — scope by JOIN).
CREATE TABLE media_favourite (
  anilist_user_id INTEGER NOT NULL REFERENCES anilist_user(id) ON DELETE CASCADE,
  media_id        INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL,           -- AniList favouriteOrder (user's preferred order)
  fetched_at      INTEGER NOT NULL,
  PRIMARY KEY (anilist_user_id, media_id)
);
CREATE INDEX media_favourite_order ON media_favourite(anilist_user_id, sort_order);

-- User's favourite characters (parent character row may not be in any media_character junction)
CREATE TABLE character_favourite (
  anilist_user_id INTEGER NOT NULL REFERENCES anilist_user(id) ON DELETE CASCADE,
  character_id    INTEGER NOT NULL REFERENCES character(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL,
  fetched_at      INTEGER NOT NULL,
  PRIMARY KEY (anilist_user_id, character_id)
);
CREATE INDEX character_favourite_order ON character_favourite(anilist_user_id, sort_order);

-- User's favourite staff
CREATE TABLE staff_favourite (
  anilist_user_id INTEGER NOT NULL REFERENCES anilist_user(id) ON DELETE CASCADE,
  staff_id        INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL,
  fetched_at      INTEGER NOT NULL,
  PRIMARY KEY (anilist_user_id, staff_id)
);
CREATE INDEX staff_favourite_order ON staff_favourite(anilist_user_id, sort_order);

-- User's favourite studios (studio row populated on first favourites import if not already there)
CREATE TABLE studio_favourite (
  anilist_user_id INTEGER NOT NULL REFERENCES anilist_user(id) ON DELETE CASCADE,
  studio_id       INTEGER NOT NULL REFERENCES studio(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL,
  fetched_at      INTEGER NOT NULL,
  PRIMARY KEY (anilist_user_id, studio_id)
);
CREATE INDEX studio_favourite_order ON studio_favourite(anilist_user_id, sort_order);
