/**
 * AniList LIST-tab filter chips. Plugged into the generic
 * [FilterBar](../../../components/FilterBar.tsx) shell via
 * `registerSourceFilters('anilist', ...)` so the LIST tab stays
 * source-agnostic and other importers (Spotify / Steam / ...) can
 * register their own chip modules later without touching this file.
 *
 * Chip set (in render order):
 *   - list status     multi-select OR (per-user MediaList.status,
 *                     default = CURRENT + COMPLETED + REPEATING)
 *   - status          multi-select OR (media.status release/publication)
 *   - genre           multi-select OR
 *   - format          multi-select OR
 *   - year            multi-select OR (media.start_year)
 *   - seasonYear      range slider over (season, season_year) tuples
 *   - score           per-user score on `media_list_entry`. Three-way
 *                     pill (Any / Only rated / Only unrated) combined
 *                     with a 1..100 range slider that sub-filters the
 *                     rated subset. Unrated = no list entry OR
 *                     `media_list_entry.score = 0` (AniList convention:
 *                     POINT_100 score of 0 means "not rated"). Chip
 *                     button label stays "score" — tooltip clarifies
 *                     it's the USER's score, not community mean_score.
 *   - studio          multi-select OR (matches if media has ANY selected)
 *   - voice actor     multi-select OR (matches if cached cast joins ANY
 *                     selected staff; lazy-loaded — chip exposes a
 *                     bulk-expand button for the uncached candidates)
 *   - tag             multi-select with mode (OR / AND) + min rank
 *                     threshold (mode + rank live in the tagoption chip)
 *   - tag options     mode (OR / AND) + min rank threshold for `tag`
 *   - exclude tag     multi-select; matches removed from results
 *
 * The filter operates almost entirely on the media table + its
 * junctions inside `anilist.sqlite`. User-scoping is opportunistic —
 * `list status` uses the latest known AniList user
 * (`getLatestAnilistUser`) so the chip "just works" without making
 * the slot blob carry user identity. If the DB has zero anilist_user
 * rows (e.g. items in this slot came from an old import that's since
 * been wiped), per-user chips degrade to "pass everything through".
 */

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import * as client from '../../db/client';
import type { DbRow } from '../../db/rpc';
import {
  type FilterChipState,
  registerSourceFilters,
  type SourceFilterModule,
} from '../../db/source-registry';
import { ANILIST_SOURCE_ID } from './anilistSource';
import type { AnilistDbExecutor, SqlBindable } from './context';
import {
  getLatestAnilistUser,
  getListEntriesByMediaIds,
  getMediaByIds,
  getMediaIdsWithDisallowedListStatus,
  getVoiceActorsForCandidates,
  type VoiceActorOption,
} from './readQueries';
import { runAnilistMediaLazyExpansion } from './runners';
import type {
  AnilistMediaFormat,
  AnilistMediaListStatus,
  AnilistMediaSeason,
  AnilistMediaStatus,
} from './types';

// ---------------------------------------------------------------------
// Chip state
//
// Plain JSON-serialisable shape so the FilterBar shell's chipStates
// map can be persisted later without touching this module. Most chips
// default to "off" (empty set / null) so the initial state passes
// every item through; `listStatuses` is the exception — see comment
// on the field below.
// ---------------------------------------------------------------------

export type TagFilterMode = 'or' | 'and';

export interface AnilistFilterChipState extends FilterChipState {
  genres: string[];
  years: number[];
  formats: AnilistMediaFormat[];
  statuses: AnilistMediaStatus[];
  studioIds: number[];
  tagNames: string[];
  tagMode: TagFilterMode;
  tagMinRank: number; // 0..100; 0 means "any rank"
  tagExclude: string[];
  // Per-user MediaList.status. Default pre-selects CURRENT/COMPLETED/
  // REPEATING so a freshly imported list doesn't blast the sorter
  // with PLANNING + DROPPED entries — those are the statuses the
  // user is almost never ranking. Raw AniList enum values are used
  // as labels to avoid the anime ("Watching") vs manga ("Reading")
  // disambiguation problem at chip-render time. Items missing a list
  // entry entirely (favourites-only imports) always pass through
  // this chip — semantics is "exclude entries whose status is NOT
  // in this set", not "require a list entry of this status".
  listStatuses: AnilistMediaListStatus[];
  // Per-user score on `media_list_entry`. Three orthogonal knobs:
  //   - userScoreInclude:
  //       'any'     — no rated/unrated filter (default)
  //       'rated'   — only items with score > 0 pass (drops unrated +
  //                   items without a list entry at all)
  //       'unrated' — only items with score === 0 OR no list entry
  //                   pass (sub-slider is ignored in this bucket)
  //   - scoreMin / scoreMax: 1..100 inclusive range within the RATED
  //     subset. Null bound = unbounded on that side. Slider edge (1
  //     for min, 100 for max) collapses to null so the chip turns
  //     off naturally. The range never applies to unrated items —
  //     they're routed by the pill, not the slider.
  // Items WITHOUT a media_list_entry row (e.g. favourites-only
  // imports for a different user) are treated as unrated by the pill
  // — same convention the user would expect ("I haven't scored
  // this"), and parallel to how the listStatuses chip lets entry-less
  // items pass through.
  userScoreInclude: 'any' | 'rated' | 'unrated';
  scoreMin: number | null;
  scoreMax: number | null;
  // Season-year range over (season, season_year) tuples, encoded as
  // year*4 + season_idx (WINTER=0, SPRING=1, SUMMER=2, FALL=3) so a
  // single integer comparison covers the whole chronological order.
  // Items with NULL season or season_year are excluded when this
  // chip is active (we can't place them on the timeline).
  seasonYearMin: number | null;
  seasonYearMax: number | null;
  // Staff ids of voice actors. Empty = chip off. When non-empty,
  // a show passes iff ANY cached character_voice_actor row joins
  // one of these staff ids. Cast data is lazy-loaded (only fetched
  // when the user opens a show's detail panel or hits the chip's
  // "Fetch cast for all N shows" button) — see anilist plan §A for
  // the lazy-expansion contract.
  voiceActorIds: number[];
}

/** Default `listStatuses` selection. Exported so the chip UI and
 *  the `isPassthrough` check can refer to the same source of truth. */
export const DEFAULT_ALLOWED_LIST_STATUSES: AnilistMediaListStatus[] = [
  'CURRENT',
  'COMPLETED',
  'REPEATING',
];

/** Full universe of AniList MediaListStatus values. Used for both
 *  the chip's dropdown options and the "all 6 selected = passthrough"
 *  check (functionally equivalent to no filter).
 *
 *  Order mirrors the user's typical engagement funnel —
 *  currently-watching first, then the historical-positive bucket
 *  (REPEATING + COMPLETED), then the on-deck bucket (PLANNING +
 *  PAUSED), then the dropped tail. Matches how the chip dropdown
 *  visually groups "stuff you're sorting by default" vs "stuff you
 *  might also include". The default selection
 *  ({@link DEFAULT_ALLOWED_LIST_STATUSES}) sits in the top three
 *  rows so it reads as a contiguous block. */
export const ALL_LIST_STATUSES: AnilistMediaListStatus[] = [
  'CURRENT',
  'REPEATING',
  'COMPLETED',
  'PLANNING',
  'PAUSED',
  'DROPPED',
];

/** AniList seasons in chronological order within a year. The index
 *  doubles as the low-bit encoding for the seasonYear range slider:
 *  encoded = year*4 + SEASON_INDEX[season]. */
const SEASON_INDEX: Record<AnilistMediaSeason, number> = {
  WINTER: 0,
  SPRING: 1,
  SUMMER: 2,
  FALL: 3,
};
const SEASON_BY_INDEX: AnilistMediaSeason[] = [
  'WINTER',
  'SPRING',
  'SUMMER',
  'FALL',
];

function encodeSeasonYear(season: AnilistMediaSeason, year: number): number {
  return year * 4 + SEASON_INDEX[season];
}

function decodeSeasonYear(encoded: number): {
  season: AnilistMediaSeason;
  year: number;
} {
  return {
    season: SEASON_BY_INDEX[encoded & 0b11]!,
    year: Math.floor(encoded / 4),
  };
}

function formatSeasonYear(encoded: number): string {
  const { season, year } = decodeSeasonYear(encoded);
  // Display in title-case ("Winter 2018") rather than the raw enum,
  // since the seasonYear chip is the one place users see a season
  // label outside of detail screens.
  const seasonLabel = season.charAt(0) + season.slice(1).toLowerCase();
  return `${seasonLabel} ${year}`;
}

/** SQL fragment that converts a media row's (season, season_year)
 *  into the same encoded integer as `encodeSeasonYear`. Yields NULL
 *  when either column is null, so BETWEEN/>=/<= correctly excludes
 *  un-placeable rows. */
const SEASON_YEAR_ENCODED_SQL = `(
  m.season_year * 4 + CASE m.season
    WHEN 'WINTER' THEN 0
    WHEN 'SPRING' THEN 1
    WHEN 'SUMMER' THEN 2
    WHEN 'FALL' THEN 3
  END
)`;

export const ANILIST_INITIAL_CHIP_STATE: AnilistFilterChipState = {
  genres: [],
  years: [],
  formats: [],
  statuses: [],
  studioIds: [],
  tagNames: [],
  tagMode: 'or',
  tagMinRank: 0,
  tagExclude: [],
  listStatuses: DEFAULT_ALLOWED_LIST_STATUSES,
  userScoreInclude: 'any',
  scoreMin: null,
  scoreMax: null,
  seasonYearMin: null,
  seasonYearMax: null,
  voiceActorIds: [],
};

// ---------------------------------------------------------------------
// SQL builder
//
// Builds the `WHERE` clause + parameter list for a "select media ids
// from a candidate set that pass every active chip" query. Pure
// function, no DB access — tests cover it by comparing the produced
// SQL/params to fixtures.
//
// Conventions:
//   - "active" means "the chip's selection is non-empty / non-null".
//     Inactive chips don't contribute any clauses.
//   - Tag mode `'or'` uses `EXISTS` per tag-name; mode `'and'` uses
//     a HAVING COUNT(DISTINCT) trick to require all names matched.
//     Min rank filters the EXISTS subquery so a tag at rank < threshold
//     doesn't count.
//   - `listStatuses` is per-user and is NOT emitted here — it's
//     applied as a post-SQL set intersection by `computeAllowedMediaIds`
//     because the builder doesn't have a user id to bind against.
// ---------------------------------------------------------------------

export interface AnilistFilterSql {
  sql: string;
  params: SqlBindable[];
}

/**
 * Returns null when no SQL-side chips are active. Caller can then
 * skip the SQL round-trip entirely and either pass everything
 * through or feed the candidate set straight into the post-SQL
 * stages (list status).
 */
export function buildAnilistFilterSql(
  candidateMediaIds: readonly number[],
  state: AnilistFilterChipState,
): AnilistFilterSql | null {
  const clauses: string[] = [];
  const params: SqlBindable[] = [];

  if (candidateMediaIds.length === 0) return null;

  const placeholders = (n: number) => new Array(n).fill('?').join(', ');

  // Genres — stored as JSON array on the media row. The Phase D plan
  // calls these out as a small fixed set and v1 keeps them denormalised.
  // The cheapest correct filter: `instr(genres_json, '"<genre>"') > 0`.
  // We anchor with quotes so substring collisions (e.g. "Action" vs
  // "Action & Adventure") don't trip the filter.
  for (const g of state.genres) {
    clauses.push(`instr(COALESCE(m.genres_json, '[]'), ?) > 0`);
    params.push(`"${g}"`);
  }

  if (state.years.length > 0) {
    clauses.push(`m.start_year IN (${placeholders(state.years.length)})`);
    params.push(...state.years);
  }
  if (state.formats.length > 0) {
    clauses.push(`m.format IN (${placeholders(state.formats.length)})`);
    params.push(...state.formats);
  }
  if (state.statuses.length > 0) {
    clauses.push(`m.status IN (${placeholders(state.statuses.length)})`);
    params.push(...state.statuses);
  }

  // User-score range + rated/unrated pill: per-user, applied post-SQL
  // by `computeAllowedMediaIds` (it needs a user id from
  // getLatestAnilistUser, same precedence as the listStatuses chip).
  // Intentionally NOT emitted here so the builder stays pure.

  // Season-year range. Both bounds compare against the encoded
  // (year*4 + season_idx) expression; rows missing season or
  // season_year yield NULL from the encoder and are excluded.
  if (state.seasonYearMin !== null) {
    clauses.push(`${SEASON_YEAR_ENCODED_SQL} >= ?`);
    params.push(state.seasonYearMin);
  }
  if (state.seasonYearMax !== null) {
    clauses.push(`${SEASON_YEAR_ENCODED_SQL} <= ?`);
    params.push(state.seasonYearMax);
  }

  if (state.studioIds.length > 0) {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM media_studio ms
        WHERE ms.media_id = m.id
          AND ms.studio_id IN (${placeholders(state.studioIds.length)})
      )`,
    );
    params.push(...state.studioIds);
  }

  if (state.tagNames.length > 0) {
    if (state.tagMode === 'or') {
      clauses.push(
        `EXISTS (
          SELECT 1 FROM media_tag mt
          WHERE mt.media_id = m.id
            AND mt.tag_name IN (${placeholders(state.tagNames.length)})
            AND mt.rank >= ?
        )`,
      );
      params.push(...state.tagNames, state.tagMinRank);
    } else {
      // AND mode: every selected tag must match at >= minRank.
      clauses.push(
        `(SELECT COUNT(DISTINCT mt.tag_name) FROM media_tag mt
           WHERE mt.media_id = m.id
             AND mt.tag_name IN (${placeholders(state.tagNames.length)})
             AND mt.rank >= ?) = ?`,
      );
      params.push(...state.tagNames, state.tagMinRank, state.tagNames.length);
    }
  }

  if (state.tagExclude.length > 0) {
    clauses.push(
      `NOT EXISTS (
        SELECT 1 FROM media_tag mt
        WHERE mt.media_id = m.id
          AND mt.tag_name IN (${placeholders(state.tagExclude.length)})
      )`,
    );
    params.push(...state.tagExclude);
  }

  // Voice actors. Cast data is lazy — shows whose detail panel
  // hasn't been opened (and that aren't covered by the chip's bulk
  // expand button) won't have character_voice_actor rows yet, so
  // they correctly NOT match. The chip UI surfaces the count of
  // uncached candidates so this isn't a silent footgun.
  if (state.voiceActorIds.length > 0) {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM character_voice_actor cva
        WHERE cva.media_id = m.id
          AND cva.staff_id IN (${placeholders(state.voiceActorIds.length)})
      )`,
    );
    params.push(...state.voiceActorIds);
  }

  if (clauses.length === 0) return null;

  const sql = `
    SELECT m.id
    FROM media m
    WHERE m.id IN (${placeholders(candidateMediaIds.length)})
      AND ${clauses.join(' AND ')}
  `;
  return {
    sql,
    params: [...candidateMediaIds, ...params],
  };
}

// ---------------------------------------------------------------------
// FilterModule (runtime registration)
// ---------------------------------------------------------------------

/**
 * True iff applying `state` would let every candidate id through
 * (no filtering happens). Also surfaced via
 * `anilistFilterModule.isPassthrough` so the FilterBar's fast-path
 * doesn't accidentally treat the *default* list-status selection as
 * "filter inactive" (those 3 statuses are a real filter — defaulting
 * to them is the whole point of the chip).
 *
 * For `listStatuses`: empty array OR all-6 selected ⇒ passthrough
 * (both mean "don't reject anything based on list status"). The
 * default ['CURRENT','COMPLETED','REPEATING'] is NOT passthrough.
 *
 * For range chips (`scoreMin/Max`, `seasonYearMin/Max`): both bounds
 * null ⇒ passthrough. Either bound set ⇒ active.
 *
 * For the user-score chip: passthrough iff `userScoreInclude === 'any'`
 * AND the slider bounds are both null. `'rated'` / `'unrated'` are
 * active by themselves even with a null range — the pill is the
 * dominant control.
 *
 * For `voiceActorIds`: empty array ⇒ passthrough. Any non-empty
 * selection is active even if every cached VA is selected — there's
 * no "universe size" we can compare against because the cast cache
 * is per-show and partial.
 */
export function isInitialState(state: AnilistFilterChipState): boolean {
  const listStatusActive =
    state.listStatuses.length > 0 &&
    state.listStatuses.length < ALL_LIST_STATUSES.length;
  const userScoreActive =
    state.userScoreInclude !== 'any' ||
    state.scoreMin !== null ||
    state.scoreMax !== null;
  const seasonYearActive =
    state.seasonYearMin !== null || state.seasonYearMax !== null;
  return (
    state.genres.length === 0 &&
    state.years.length === 0 &&
    state.formats.length === 0 &&
    state.statuses.length === 0 &&
    state.studioIds.length === 0 &&
    state.tagNames.length === 0 &&
    state.tagExclude.length === 0 &&
    state.voiceActorIds.length === 0 &&
    !listStatusActive &&
    !userScoreActive &&
    !seasonYearActive
  );
}

/**
 * Compute the subset of `candidateMediaIds` that pass `state`. The
 * SQL chips run first, then the per-user list-status chip is applied
 * as a set intersect (it needs a user id from `getLatestAnilistUser`
 * and is awkward to bind through the pure SQL builder).
 */
export async function computeAllowedMediaIds(
  candidateMediaIds: readonly number[],
  state: AnilistFilterChipState,
): Promise<Set<number>> {
  if (candidateMediaIds.length === 0) return new Set();
  if (isInitialState(state)) {
    return new Set(candidateMediaIds);
  }

  // Stage 1: SQL chips. Route through defaultDbForFilters so the test
  // injection seam (setFilterDbForTesting) covers this code path.
  let allowed: Set<number>;
  const sqlOut = buildAnilistFilterSql(candidateMediaIds, state);
  if (sqlOut) {
    const rows = await defaultExec(sqlOut.sql, sqlOut.params);
    allowed = new Set(rows.map((r) => Number(r.id)));
  } else {
    allowed = new Set(candidateMediaIds);
  }

  // Stage 2: list status filter — per-user, so handled here rather
  // than in the SQL builder. Only active when the user has touched
  // the chip (not the all-allowed passthrough state). Items WITHOUT
  // a media_list_entry pass through (think favourites-only imports);
  // only items whose list entry has a status NOT in `listStatuses`
  // are excluded. Semantics: "hide entries in statuses I'm not
  // interested in", not "require a list entry in one of these
  // statuses".
  const listStatusActive =
    state.listStatuses.length > 0 &&
    state.listStatuses.length < ALL_LIST_STATUSES.length;
  const userScoreActive =
    state.userScoreInclude !== 'any' ||
    state.scoreMin !== null ||
    state.scoreMax !== null;

  // Both per-user filters need the latest user id — fetch once and
  // share across stages. If there's no anilist_user row at all (stale
  // shared DB, new install, etc.) we fail OPEN for the list-status
  // chip and the user-score chip alike: better to show too much than
  // to silently render "0 items" when the real cause is missing user
  // context, not a real filter mismatch.
  let cachedUserId: number | null | undefined;
  async function getUserId(): Promise<number | null> {
    if (cachedUserId !== undefined) return cachedUserId;
    const user = await getLatestAnilistUser(defaultDbForFilters());
    cachedUserId = user ? user.id : null;
    return cachedUserId;
  }

  if (listStatusActive) {
    const db = defaultDbForFilters();
    const userId = await getUserId();
    if (userId !== null) {
      const disallowed = await getMediaIdsWithDisallowedListStatus(
        db,
        userId,
        state.listStatuses,
        candidateMediaIds,
      );
      if (disallowed.size > 0) {
        const filtered = new Set<number>();
        for (const id of allowed) {
          if (!disallowed.has(id)) filtered.add(id);
        }
        allowed = filtered;
      }
    }
  }

  // Stage 3: per-user score filter (rated/unrated pill + 1..100 range
  // within the rated subset). Items without a media_list_entry row
  // are treated as unrated — that mirrors what the user perceives
  // ("I haven't scored this") and is symmetric with how listStatuses
  // lets entry-less items pass through.
  if (userScoreActive && allowed.size > 0) {
    const userId = await getUserId();
    if (userId !== null) {
      // Only query for the ids still in the allowed set after stage 2
      // — no point asking about ids the listStatuses chip already
      // dropped. (Empty allowed set returns Map() immediately.)
      const allowedIds = Array.from(allowed);
      const entries = await getListEntriesByMediaIds(
        defaultDbForFilters(),
        userId,
        allowedIds,
      );
      const filtered = new Set<number>();
      for (const id of allowed) {
        const entry = entries.get(id);
        // AniList POINT_100 convention: 0 means "unrated"; an entry
        // with score > 0 is "rated". An entirely absent entry is
        // also "unrated" per the favourites-only convention above.
        const score = entry?.score ?? 0;
        const isRated = score > 0;

        if (state.userScoreInclude === 'rated' && !isRated) continue;
        if (state.userScoreInclude === 'unrated' && isRated) continue;

        // Range only applies inside the rated bucket; unrated items
        // that survive the pill always pass the range stage.
        if (isRated) {
          if (state.scoreMin !== null && score < state.scoreMin) continue;
          if (state.scoreMax !== null && score > state.scoreMax) continue;
        }
        filtered.add(id);
      }
      allowed = filtered;
    }
  }

  return allowed;
}

// Test injection seam — tests use `setFilterDbForTesting(db)` to point
// the chip discovery and computeAllowedMediaIds at an in-memory DB
// instead of the worker-backed client. Defaults to the real client so
// production callers don't need to thread anything.
let injectedDb: AnilistDbExecutor | null = null;

export function setFilterDbForTesting(db: AnilistDbExecutor | null): void {
  injectedDb = db;
}

function defaultDbForFilters(): AnilistDbExecutor {
  if (injectedDb) return injectedDb;
  return {
    exec: (sql, params) =>
      client.exec(ANILIST_SOURCE_ID, sql, params ? [...params] : undefined),
    execBatch: (statements) =>
      client.execBatch(
        ANILIST_SOURCE_ID,
        statements.map((s) => ({
          sql: s.sql,
          params: s.params ? [...s.params] : undefined,
        })),
      ),
  };
}

function defaultExec(sql: string, params: readonly SqlBindable[]): Promise<DbRow[]> {
  return defaultDbForFilters().exec(sql, params);
}

// ---------------------------------------------------------------------
// Chip UI
//
// Compact chip controls rendered inline by the FilterBar shell. Each
// chip is a popover-less inline button or a button with a small
// floating menu — no modal dialogs, no third-party popover lib, to
// keep the bar visually flat and the dependency surface small.
// ---------------------------------------------------------------------

function patchState(
  current: AnilistFilterChipState,
  patch: Partial<AnilistFilterChipState>,
): AnilistFilterChipState {
  return { ...current, ...patch };
}

export function toggleInArray<T>(arr: readonly T[], value: T): T[] {
  return arr.includes(value)
    ? arr.filter((x) => x !== value)
    : [...arr, value];
}

interface ChipsHostProps {
  externalIds: ReadonlySet<string | number>;
  chipState: FilterChipState;
  onChipStateChange: (patch: FilterChipState) => void;
}

const ALL_FORMATS: AnilistMediaFormat[] = [
  'TV',
  'TV_SHORT',
  'MOVIE',
  'SPECIAL',
  'OVA',
  'ONA',
  'MUSIC',
  'MANGA',
  'NOVEL',
  'ONE_SHOT',
];
const ALL_STATUSES: AnilistMediaStatus[] = [
  'FINISHED',
  'RELEASING',
  'NOT_YET_RELEASED',
  'CANCELLED',
  'HIATUS',
];

/**
 * Discovery query: pull the universe of options for chip selectors
 * (genres, years, studios, tag names, season+year tuples, cached
 * voice actors) FROM the candidate ids actually in the slot. Keeps
 * chip menus relevant — no "filter by Sci-Fi" when the user's slot
 * has zero sci-fi shows.
 */
interface ChipOptions {
  genres: string[];
  years: number[];
  studios: Array<{ id: number; name: string }>;
  tagNames: string[];
  seasonYearEncoded: number[]; // sorted ascending
  // VAs are only discovered for shows whose cast has been lazy-fetched.
  // The chip UI surfaces the count of uncached candidates so the
  // discovery cap is visible to the user.
  voiceActors: VoiceActorOption[];
  cachedCastMediaIds: ReadonlySet<number>;
}

async function loadChipOptions(
  externalIds: readonly number[],
): Promise<ChipOptions> {
  if (externalIds.length === 0) {
    return {
      genres: [],
      years: [],
      studios: [],
      tagNames: [],
      seasonYearEncoded: [],
      voiceActors: [],
      cachedCastMediaIds: new Set(),
    };
  }
  const db = defaultDbForFilters();
  const media = await getMediaByIds(db, externalIds);
  const genres = new Set<string>();
  const years = new Set<number>();
  const seasonYearEncoded = new Set<number>();
  for (const m of media) {
    if (m.genres_json) {
      try {
        const arr = JSON.parse(m.genres_json) as unknown;
        if (Array.isArray(arr)) {
          for (const g of arr) {
            if (typeof g === 'string') genres.add(g);
          }
        }
      } catch {
        // Malformed JSON shouldn't crash chip discovery — just skip.
      }
    }
    if (m.start_year !== null) years.add(m.start_year);
    if (m.season !== null && m.season_year !== null) {
      // Encode here (rather than at chip-render time) so the
      // SeasonYearChip can sort + dedupe by a primitive int.
      seasonYearEncoded.add(
        encodeSeasonYear(m.season as AnilistMediaSeason, m.season_year),
      );
    }
  }
  const ph = new Array(externalIds.length).fill('?').join(', ');
  const studioRows = await defaultExec(
    `SELECT DISTINCT s.id, s.name
       FROM media_studio ms JOIN studio s ON s.id = ms.studio_id
       WHERE ms.media_id IN (${ph})
       ORDER BY s.name COLLATE NOCASE`,
    externalIds,
  );
  const tagRows = await defaultExec(
    `SELECT DISTINCT tag_name FROM media_tag
       WHERE media_id IN (${ph})
       ORDER BY tag_name COLLATE NOCASE`,
    externalIds,
  );
  // Voice actors discoverable from the candidate set's cached cast.
  // Surfaced as both a flat list (chip dropdown) and a set of media
  // ids with cached cast (so the chip can show "X/Y shows have cast
  // cached" + offer to expand the rest).
  const voiceActors = await getVoiceActorsForCandidates(db, externalIds);
  const cachedCastRows = await defaultExec(
    `SELECT DISTINCT media_id FROM character_voice_actor
       WHERE media_id IN (${ph})`,
    externalIds,
  );
  const cachedCastMediaIds = new Set<number>();
  for (const r of cachedCastRows) cachedCastMediaIds.add(Number(r.media_id));
  return {
    genres: Array.from(genres).sort((a, b) => a.localeCompare(b)),
    years: Array.from(years).sort((a, b) => b - a),
    studios: studioRows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
    })),
    tagNames: tagRows.map((r) => String(r.tag_name)),
    seasonYearEncoded: Array.from(seasonYearEncoded).sort((a, b) => a - b),
    voiceActors,
    cachedCastMediaIds,
  };
}

export function MultiSelectChip<T extends string | number>({
  label,
  options,
  selected,
  onToggle,
  formatOption,
  onReplaceAll,
  searchable = false,
  searchPlaceholder,
}: {
  label: string;
  options: readonly T[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  formatOption?: (value: T) => string;
  /** Optional bulk-set callback. When provided, the popover renders
   *  "Select all" + "Clear" buttons in a toolbar at the top. Selecting
   *  all replaces the current selection with the full options array;
   *  clearing replaces it with []. Each button is disabled when its
   *  action would be a no-op (already all selected / already empty). */
  onReplaceAll?: (values: readonly T[]) => void;
  /** When true, render a search input at the top of the menu (mirrors
   *  the voice-actor chip). Selected options always render above the
   *  search-filtered unselected list so toggling a selection off after
   *  a search doesn't make it disappear from view. */
  searchable?: boolean;
  searchPlaceholder?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Ref wraps the whole chip (trigger + menu) so the outside-click
  // hook recognises a click on the trigger as "inside" — otherwise
  // the same mousedown that opens the menu would also fire the
  // outside-click handler and immediately close it again.
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));
  const count = selected.length;

  // Format-or-stringify helper, used both for rendering and for the
  // search needle match so what the user types matches what they see.
  const formatOpt = (opt: T): string =>
    formatOption ? formatOption(opt) : String(opt);

  // Split + filter only when we're actually rendering the menu — the
  // chip might never be opened in a session, no point doing work
  // upfront. Selected-on-top mirrors VoiceActorChip's contract.
  let selectedOptions: readonly T[] = options;
  let unselectedOptions: readonly T[] = [];
  if (searchable) {
    const selectedSet = new Set<T>(selected);
    selectedOptions = options.filter((o) => selectedSet.has(o));
    const restOptions = options.filter((o) => !selectedSet.has(o));
    const needle = search.trim().toLowerCase();
    unselectedOptions = needle
      ? restOptions.filter((o) => formatOpt(o).toLowerCase().includes(needle))
      : restOptions;
  }

  const allSelected = options.length > 0 && selected.length === options.length;

  return (
    <div
      ref={rootRef}
      className={`filter-chip ${count > 0 ? 'active' : ''}`}
    >
      <button
        type="button"
        className="filter-chip-button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        {label}
        {count > 0 ? ` · ${count}` : ''}
      </button>
      {open && (
        <div className="filter-chip-menu" role="menu">
          {searchable && options.length > 0 && (
            <input
              type="search"
              className="filter-chip-search"
              placeholder={searchPlaceholder ?? `Search ${label}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          )}
          {onReplaceAll && options.length > 0 && (
            <div className="filter-chip-toolbar">
              <button
                type="button"
                className="filter-chip-action"
                disabled={allSelected}
                onClick={() => onReplaceAll(options)}
                title="Select every option"
              >
                Select all
              </button>
              <button
                type="button"
                className="filter-chip-action"
                disabled={count === 0}
                onClick={() => onReplaceAll([])}
                title="Clear the current selection"
              >
                Clear
              </button>
            </div>
          )}
          {options.length === 0 && (
            <div className="filter-chip-empty">(no options)</div>
          )}
          {searchable ? (
            <>
              {selectedOptions.map((opt) => (
                <label key={`sel-${String(opt)}`} className="filter-chip-option">
                  <input
                    type="checkbox"
                    checked
                    onChange={() => onToggle(opt)}
                  />
                  <span>{formatOpt(opt)}</span>
                </label>
              ))}
              {selectedOptions.length > 0 && unselectedOptions.length > 0 && (
                <div className="filter-chip-divider" />
              )}
              {options.length > 0 && unselectedOptions.length === 0 && search && (
                <div className="filter-chip-empty">(no matches)</div>
              )}
              {unselectedOptions.map((opt) => (
                <label key={String(opt)} className="filter-chip-option">
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => onToggle(opt)}
                  />
                  <span>{formatOpt(opt)}</span>
                </label>
              ))}
            </>
          ) : (
            options.map((opt) => (
              <label key={String(opt)} className="filter-chip-option">
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  onChange={() => onToggle(opt)}
                />
                <span>{formatOpt(opt)}</span>
              </label>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Dual-handle range slider. Two `<input type="range">` are absolutely
 * positioned over a shared track + fill bar; each onChange clamps the
 * value against the other handle so the pair never crosses. Pure
 * presentation — the caller owns the [lo, hi] state and decides
 * what (if anything) to do when a handle is at the slider's edge.
 *
 * The pointer-events trick: the range inputs cover the whole width
 * but only the thumb pseudo-elements re-enable pointer events, so
 * clicks land on whichever thumb the cursor is over (the underlying
 * fill/track are decoration only).
 */
export function DualRangeSlider({
  min,
  max,
  step = 1,
  value,
  onChange,
  ariaLabelMin,
  ariaLabelMax,
}: {
  min: number;
  max: number;
  step?: number;
  value: [number, number];
  onChange: (next: [number, number]) => void;
  ariaLabelMin?: string;
  ariaLabelMax?: string;
}): ReactNode {
  const [lo, hi] = value;
  // Clamp into [min, max] for display — a stale chip state (e.g.
  // candidates changed and the stored bound is now outside the new
  // slider universe) shouldn't crash, just pin to the nearest edge.
  const safeLo = Math.min(Math.max(lo, min), max);
  const safeHi = Math.min(Math.max(hi, min), max);
  const span = Math.max(0, max - min);
  const loPct = span === 0 ? 0 : ((safeLo - min) / span) * 100;
  const hiPct = span === 0 ? 100 : ((safeHi - min) / span) * 100;
  const disabled = span === 0;

  return (
    <div className={`dual-range-slider ${disabled ? 'disabled' : ''}`}>
      <div className="dual-range-track" />
      <div
        className="dual-range-fill"
        style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeLo}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange([Math.min(v, safeHi), safeHi]);
        }}
        aria-label={ariaLabelMin ?? 'range minimum'}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeHi}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange([safeLo, Math.max(v, safeLo)]);
        }}
        aria-label={ariaLabelMax ?? 'range maximum'}
      />
    </div>
  );
}

/**
 * Range chip for the season-year filter. The slider runs from the
 * lowest to the highest discovered (season, year) tuple in the
 * candidate set with season-level precision (step = 1 on the encoded
 * year*4 + season_idx integer). Year-only number inputs flank the
 * slider for "jump to a specific year" — typing in the min input
 * snaps to WINTER of that year; the max input snaps to FALL. Drag
 * the slider afterwards to fine-tune to a specific season.
 *
 * Edge collapse: any time a handle is dragged or a year is typed
 * that puts the bound at the slider's extreme, the corresponding
 * chip-state field becomes `null` so the chip naturally toggles
 * back to "off" — keeps the UI's active vs inactive feel
 * symmetrical between slider drags and explicit clears.
 */
function SeasonYearChip({
  options,
  min,
  max,
  onChange,
}: {
  options: readonly number[]; // encoded values, sorted ascending
  min: number | null;
  max: number | null;
  onChange: (patch: {
    seasonYearMin: number | null;
    seasonYearMax: number | null;
  }) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));
  const active = min !== null || max !== null;
  const label = active
    ? `seasonYear · ${rangeLabel(min, max, formatSeasonYear)}`
    : 'seasonYear';

  const hasOptions = options.length > 0;
  const sliderMin = hasOptions ? options[0]! : 0;
  const sliderMax = hasOptions ? options[options.length - 1]! : 0;
  const lo = min ?? sliderMin;
  const hi = max ?? sliderMax;
  const sliderMinYear = Math.floor(sliderMin / 4);
  const sliderMaxYear = Math.floor(sliderMax / 4);

  // Year-only text state: the slider exposes season-level precision,
  // but the inputs deal in whole years to keep typing fast. Sync from
  // chip state via useEffect so external changes (slider drag, clear)
  // flow back to the inputs.
  const [minText, setMinText] = useState<string>(
    min === null ? '' : String(Math.floor(lo / 4)),
  );
  const [maxText, setMaxText] = useState<string>(
    max === null ? '' : String(Math.floor(hi / 4)),
  );
  useEffect(() => {
    setMinText(min === null ? '' : String(Math.floor((min ?? sliderMin) / 4)));
  }, [min, sliderMin]);
  useEffect(() => {
    setMaxText(max === null ? '' : String(Math.floor((max ?? sliderMax) / 4)));
  }, [max, sliderMax]);

  function parseYear(text: string): number | null | undefined {
    if (text === '') return null;
    const n = Number(text);
    if (!Number.isInteger(n)) return undefined; // reject
    return n;
  }

  function commitMin(): void {
    const parsed = parseYear(minText);
    if (parsed === undefined) {
      setMinText(min === null ? '' : String(Math.floor(lo / 4)));
      return;
    }
    if (parsed === null) {
      onChange({ seasonYearMin: null, seasonYearMax: max });
      return;
    }
    // Snap to WINTER (year*4), clamp into the slider universe, then
    // collapse to null when at the edge so the chip can turn off.
    const encoded = Math.min(sliderMax, Math.max(sliderMin, parsed * 4));
    const nextMin = encoded === sliderMin ? null : encoded;
    // Keep max >= min by pushing max up if the typed min outranges it.
    const nextMax = max !== null && nextMin !== null && max < nextMin ? nextMin : max;
    onChange({ seasonYearMin: nextMin, seasonYearMax: nextMax });
  }

  function commitMax(): void {
    const parsed = parseYear(maxText);
    if (parsed === undefined) {
      setMaxText(max === null ? '' : String(Math.floor(hi / 4)));
      return;
    }
    if (parsed === null) {
      onChange({ seasonYearMin: min, seasonYearMax: null });
      return;
    }
    // Snap to FALL (year*4 + 3), clamp, then collapse-on-edge.
    const encoded = Math.min(sliderMax, Math.max(sliderMin, parsed * 4 + 3));
    const nextMax = encoded === sliderMax ? null : encoded;
    const nextMin = min !== null && nextMax !== null && min > nextMax ? nextMax : min;
    onChange({ seasonYearMin: nextMin, seasonYearMax: nextMax });
  }

  function onSliderChange([newLo, newHi]: [number, number]): void {
    onChange({
      seasonYearMin: newLo === sliderMin ? null : newLo,
      seasonYearMax: newHi === sliderMax ? null : newHi,
    });
  }

  return (
    <div ref={rootRef} className={`filter-chip ${active ? 'active' : ''}`}>
      <button
        type="button"
        className="filter-chip-button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        title="Filter by season + year range"
      >
        {label}
      </button>
      {open && (
        <div className="filter-chip-menu filter-chip-menu-wide" role="menu">
          {!hasOptions ? (
            <div className="filter-chip-empty">
              (no candidates have a known season + year)
            </div>
          ) : (
            <>
              <div className="filter-chip-slider-row">
                <input
                  type="number"
                  min={sliderMinYear}
                  max={sliderMaxYear}
                  step={1}
                  value={minText}
                  onChange={(e) => setMinText(e.target.value)}
                  onBlur={commitMin}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className="filter-chip-slider-input"
                  placeholder={String(sliderMinYear)}
                  aria-label="season-year minimum (year)"
                />
                <DualRangeSlider
                  min={sliderMin}
                  max={sliderMax}
                  value={[lo, hi]}
                  onChange={onSliderChange}
                  ariaLabelMin="season-year range minimum"
                  ariaLabelMax="season-year range maximum"
                />
                <input
                  type="number"
                  min={sliderMinYear}
                  max={sliderMaxYear}
                  step={1}
                  value={maxText}
                  onChange={(e) => setMaxText(e.target.value)}
                  onBlur={commitMax}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className="filter-chip-slider-input"
                  placeholder={String(sliderMaxYear)}
                  aria-label="season-year maximum (year)"
                />
              </div>
              {/* Decoded season+year labels under the slider — the
                  year-only inputs hide the season precision available
                  via the slider drag, so surface it explicitly. */}
              <div className="filter-chip-slider-labels">
                <span>{formatSeasonYear(lo)}</span>
                <span>{formatSeasonYear(hi)}</span>
              </div>
              {active && (
                <button
                  type="button"
                  className="filter-chip-action"
                  onClick={() =>
                    onChange({ seasonYearMin: null, seasonYearMax: null })
                  }
                >
                  Clear range
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Per-user-score chip. The label stays "score" (the user has it
 * memorised) but the underlying semantics filter on the USER's own
 * AniList score, not the community `mean_score`. A tooltip on the
 * chip button clarifies this when the user hovers.
 *
 * Two layered controls:
 *   1. Tri-state pill: Any / Only rated / Only unrated. This is the
 *      dominant control — it routes items into the rated vs unrated
 *      bucket BEFORE the slider is evaluated. "Only unrated" disables
 *      the slider (it'd be meaningless — unrated items have score 0
 *      by definition).
 *   2. Dual-handle range slider (1..100) flanked by typed inputs.
 *      Only filters the rated bucket. The slider universe starts at 1
 *      because score=0 means "unrated" — that case is handled by the
 *      pill, not the range. Slider edges (1 for min, 100 for max)
 *      collapse to null so the chip naturally turns off when dragged
 *      to the extreme.
 */
function ScoreRangeChip({
  pill,
  min,
  max,
  onChange,
}: {
  pill: AnilistFilterChipState['userScoreInclude'];
  min: number | null;
  max: number | null;
  onChange: (
    patch: Partial<
      Pick<AnilistFilterChipState, 'userScoreInclude' | 'scoreMin' | 'scoreMax'>
    >,
  ) => void;
}): ReactNode {
  const SLIDER_MIN = 1;
  const SLIDER_MAX = 100;

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));
  const rangeActive = min !== null || max !== null;
  const pillActive = pill !== 'any';
  const active = pillActive || rangeActive;

  // Pill takes precedence in the chip's short label: "score · rated"
  // is more informative than "score · 60–80" when both are set, and
  // the user can see the range expanded in the menu anyway.
  let label = 'score';
  if (pill === 'rated') {
    label = rangeActive
      ? `score · rated, ${rangeLabel(min, max, String)}`
      : 'score · rated';
  } else if (pill === 'unrated') {
    label = 'score · unrated';
  } else if (rangeActive) {
    label = `score · ${rangeLabel(min, max, String)}`;
  }

  const sliderDisabled = pill === 'unrated';
  const lo = min ?? SLIDER_MIN;
  const hi = max ?? SLIDER_MAX;

  // Local string state for the inputs so users can type freely
  // (e.g. clear the field, type "65") without us coercing "" to 0
  // on every keystroke. Sync to chip state only on blur / Enter or
  // when the value is a valid integer in range.
  const [minText, setMinText] = useState<string>(min === null ? '' : String(min));
  const [maxText, setMaxText] = useState<string>(max === null ? '' : String(max));
  useEffect(() => {
    setMinText(min === null ? '' : String(min));
  }, [min]);
  useEffect(() => {
    setMaxText(max === null ? '' : String(max));
  }, [max]);

  function parseBound(text: string): number | null | undefined {
    if (text === '') return null;
    const n = Number(text);
    if (!Number.isFinite(n) || n < SLIDER_MIN || n > SLIDER_MAX) return undefined;
    return Math.round(n);
  }

  function commitMin(): void {
    const parsed = parseBound(minText);
    if (parsed === undefined) {
      setMinText(min === null ? '' : String(min));
      return;
    }
    // Collapse the slider edge (1) to null so the chip naturally
    // turns off — `>= 1` is a no-op filter on a 1..100 range.
    const collapsed = parsed === SLIDER_MIN ? null : parsed;
    // Don't let a typed min silently overshoot the current max — push
    // max up to match so the user's range is still self-consistent.
    const nextMax = max !== null && collapsed !== null && max < collapsed ? collapsed : max;
    onChange({ scoreMin: collapsed, scoreMax: nextMax });
  }

  function commitMax(): void {
    const parsed = parseBound(maxText);
    if (parsed === undefined) {
      setMaxText(max === null ? '' : String(max));
      return;
    }
    const collapsed = parsed === SLIDER_MAX ? null : parsed;
    const nextMin = min !== null && collapsed !== null && min > collapsed ? collapsed : min;
    onChange({ scoreMin: nextMin, scoreMax: collapsed });
  }

  function onSliderChange([newLo, newHi]: [number, number]): void {
    onChange({
      scoreMin: newLo === SLIDER_MIN ? null : newLo,
      scoreMax: newHi === SLIDER_MAX ? null : newHi,
    });
  }

  return (
    <div ref={rootRef} className={`filter-chip ${active ? 'active' : ''}`}>
      <button
        type="button"
        className="filter-chip-button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        title={'user score — your personal score from your AniList list (1–100). Items with score 0 or no list entry are unrated.'}
      >
        {label}
      </button>
      {open && (
        <div className="filter-chip-menu filter-chip-menu-wide" role="menu">
          {/* Pill: Any / Only rated / Only unrated. The dominant
              control — narrows or excludes the rated/unrated buckets
              before the slider applies. */}
          <div className="filter-chip-range-row">
            <span>show</span>
            <div className="filter-chip-segmented">
              <button
                type="button"
                className={pill === 'any' ? 'active' : ''}
                onClick={() => onChange({ userScoreInclude: 'any' })}
                title="Don't filter by rated / unrated"
              >
                Any
              </button>
              <button
                type="button"
                className={pill === 'rated' ? 'active' : ''}
                onClick={() => onChange({ userScoreInclude: 'rated' })}
                title="Only items with a score > 0 in your AniList list"
              >
                Only rated
              </button>
              <button
                type="button"
                className={pill === 'unrated' ? 'active' : ''}
                onClick={() =>
                  // Going to "unrated" zeros the range — the slider is
                  // meaningless for unrated items, so persisting stale
                  // bounds would create a confusing "score · unrated,
                  // 60–80" label.
                  onChange({
                    userScoreInclude: 'unrated',
                    scoreMin: null,
                    scoreMax: null,
                  })
                }
                title="Only items you haven't scored yet (or that aren't on your list)"
              >
                Only unrated
              </button>
            </div>
          </div>
          <div
            className={`filter-chip-slider-row ${sliderDisabled ? 'filter-chip-disabled' : ''}`}
            title={
              sliderDisabled
                ? 'Range is ignored when showing only unrated items'
                : undefined
            }
          >
            <input
              type="number"
              min={SLIDER_MIN}
              max={SLIDER_MAX}
              step={1}
              value={minText}
              onChange={(e) => setMinText(e.target.value)}
              onBlur={commitMin}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="filter-chip-slider-input"
              placeholder={String(SLIDER_MIN)}
              aria-label="score minimum"
              disabled={sliderDisabled}
            />
            <DualRangeSlider
              min={SLIDER_MIN}
              max={SLIDER_MAX}
              value={[lo, hi]}
              onChange={onSliderChange}
              ariaLabelMin="score range minimum"
              ariaLabelMax="score range maximum"
            />
            <input
              type="number"
              min={SLIDER_MIN}
              max={SLIDER_MAX}
              step={1}
              value={maxText}
              onChange={(e) => setMaxText(e.target.value)}
              onBlur={commitMax}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="filter-chip-slider-input"
              placeholder={String(SLIDER_MAX)}
              aria-label="score maximum"
              disabled={sliderDisabled}
            />
          </div>
          {active && (
            <button
              type="button"
              className="filter-chip-action"
              onClick={() =>
                onChange({
                  userScoreInclude: 'any',
                  scoreMin: null,
                  scoreMax: null,
                })
              }
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "60-90" / "≥ 60" / "≤ 90" depending on which bounds are present.
 *  Assumes the caller has already filtered out the both-null case. */
export function rangeLabel<T>(
  min: T | null,
  max: T | null,
  format: (v: T) => string,
): string {
  if (min !== null && max !== null) return `${format(min)} — ${format(max)}`;
  if (min !== null) return `≥ ${format(min)}`;
  if (max !== null) return `≤ ${format(max)}`;
  return '';
}

/**
 * Combined tag-options chip: tag combination mode (OR / AND) and the
 * min rank threshold for both the `tag` and the (implicit) `exclude
 * tag` chips. Kept separate from the `tag` chip itself so the tag
 * dropdown stays focused on name selection.
 */
function TagOptionsChip({
  mode,
  minRank,
  onChange,
}: {
  mode: TagFilterMode;
  minRank: number;
  onChange: (patch: {
    tagMode?: TagFilterMode;
    tagMinRank?: number;
  }) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));
  // "Active" when the user has nudged either control off its default
  // (OR mode + rank 0). Note that tagoption ALONE doesn't affect the
  // SQL output unless `tagNames` is also non-empty — but we still
  // surface "active" here so the user sees their non-default setting
  // even with no tags selected (otherwise the chip silently looks
  // off and they might re-set it later).
  const active = mode !== 'or' || minRank > 0;
  const label = active
    ? `tag options · ${mode.toUpperCase()}${minRank > 0 ? `, rank ≥ ${minRank}` : ''}`
    : 'tag options';

  return (
    <div ref={rootRef} className={`filter-chip ${active ? 'active' : ''}`}>
      <button
        type="button"
        className="filter-chip-button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        title="Tag combination mode and minimum rank"
      >
        {label}
      </button>
      {open && (
        <div className="filter-chip-menu" role="menu">
          <div className="filter-chip-range-row">
            <span>mode</span>
            <div className="filter-chip-segmented">
              <button
                type="button"
                className={mode === 'or' ? 'active' : ''}
                onClick={() => onChange({ tagMode: 'or' })}
              >
                OR
              </button>
              <button
                type="button"
                className={mode === 'and' ? 'active' : ''}
                onClick={() => onChange({ tagMode: 'and' })}
              >
                AND
              </button>
            </div>
          </div>
          <label className="filter-chip-range-row">
            <span>rank ≥</span>
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              value={minRank}
              onChange={(e) =>
                onChange({ tagMinRank: Number(e.target.value) || 0 })
              }
              className="filter-chip-number"
            />
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * Voice-actor chip. Differs from MultiSelectChip in two ways:
 *   - An inline search input narrows the dropdown (VA universes can
 *     run into the hundreds even for a single slot).
 *   - A footer slot exposes the cached-cast count + the bulk-expand
 *     trigger so the user can see (and act on) the lazy-loading
 *     limitation without leaving the chip.
 *
 * Selected VAs are always shown at the top of the dropdown even when
 * they don't match the active search — otherwise toggling a selection
 * off after typing a different name would silently disappear from
 * view.
 */
function VoiceActorChip({
  options,
  selected,
  onToggle,
  cachedCount,
  totalCount,
  onBulkExpand,
  bulkExpandStatus,
}: {
  options: readonly VoiceActorOption[];
  selected: readonly number[];
  onToggle: (id: number) => void;
  cachedCount: number;
  totalCount: number;
  onBulkExpand: () => void;
  bulkExpandStatus: BulkExpandStatus;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));

  const needle = search.trim().toLowerCase();
  const selectedSet = new Set(selected);
  const selectedOptions = options.filter((o) => selectedSet.has(o.id));
  const unselectedOptions = options.filter((o) => !selectedSet.has(o.id));
  const matchingUnselected = needle
    ? unselectedOptions.filter((o) => o.name.toLowerCase().includes(needle))
    : unselectedOptions;

  const count = selected.length;
  const uncachedCount = Math.max(0, totalCount - cachedCount);
  return (
    <div
      ref={rootRef}
      className={`filter-chip ${count > 0 ? 'active' : ''}`}
    >
      <button
        type="button"
        className="filter-chip-button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        title="Filter by voice actor (cast cache only)"
      >
        voice actor
        {count > 0 ? ` · ${count}` : ''}
      </button>
      {open && (
        <div className="filter-chip-menu" role="menu">
          <input
            type="search"
            className="filter-chip-search"
            placeholder="Search voice actors…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {selectedOptions.map((o) => (
            <label key={`sel-${o.id}`} className="filter-chip-option">
              <input
                type="checkbox"
                checked
                onChange={() => onToggle(o.id)}
              />
              <span>{o.name}</span>
            </label>
          ))}
          {selectedOptions.length > 0 && matchingUnselected.length > 0 && (
            <div className="filter-chip-divider" />
          )}
          {matchingUnselected.length === 0 && (
            <div className="filter-chip-empty">
              {needle
                ? '(no matches in cached cast)'
                : '(no cast cached yet)'}
            </div>
          )}
          {matchingUnselected.map((o) => (
            <label key={o.id} className="filter-chip-option">
              <input
                type="checkbox"
                checked={false}
                onChange={() => onToggle(o.id)}
              />
              <span>{o.name}</span>
            </label>
          ))}
          {/* Cast-coverage footer: total candidates vs cached. The
              bulk-expand button is the user's escape hatch for the
              "VA filter only sees opened shows" footgun — it runs
              lazyExpansion across all uncached candidates. */}
          <div className="filter-chip-footer">
            <div className="filter-chip-footer-status">
              cast cached: {cachedCount}/{totalCount}
              {bulkExpandStatus.kind === 'running' && (
                <>
                  {' '}— fetching {bulkExpandStatus.done}/
                  {bulkExpandStatus.total}…
                </>
              )}
              {bulkExpandStatus.kind === 'error' && (
                <>
                  {' '}—{' '}
                  <span className="filter-chip-error">
                    {bulkExpandStatus.message}
                  </span>
                </>
              )}
            </div>
            <button
              type="button"
              className="filter-chip-action"
              disabled={
                uncachedCount === 0 || bulkExpandStatus.kind === 'running'
              }
              onClick={onBulkExpand}
              title={
                uncachedCount === 0
                  ? 'Every candidate already has cached cast'
                  : `Fetch cast for ${uncachedCount} uncached show${
                      uncachedCount === 1 ? '' : 's'
                    } (sequential; may take a while)`
              }
            >
              {uncachedCount === 0
                ? 'All cast cached'
                : `Fetch cast for ${uncachedCount} show${uncachedCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Status of the VA chip's bulk-expansion job. Lives on the parent
 *  so re-opening the dropdown shows in-flight progress instead of
 *  resetting on close. */
type BulkExpandStatus =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'error'; message: string };

function AnilistChips({
  externalIds,
  chipState,
  onChipStateChange,
}: ChipsHostProps): ReactNode {
  const state = chipState as AnilistFilterChipState;
  const externalIdsArray = Array.from(externalIds, (x) => Number(x));
  // Discovery runs once per externalIds-identity. The shell already
  // memoises the bucket, so this re-runs only when the slot's anilist
  // items actually change.
  const [options, setOptions] = useState<ChipOptions>({
    genres: [],
    years: [],
    studios: [],
    tagNames: [],
    seasonYearEncoded: [],
    voiceActors: [],
    cachedCastMediaIds: new Set(),
  });
  // Bulk-expand status is local to the chip group (not persisted in
  // chipState — it's a transient job, not a filter selection). Bumps
  // `discoveryBust` on completion so the VA list re-discovers from
  // the now-larger cached-cast pool without remounting the chip.
  const [bulkExpandStatus, setBulkExpandStatus] = useState<BulkExpandStatus>({
    kind: 'idle',
  });
  const [discoveryBust, setDiscoveryBust] = useState(0);
  // useEffect's dep list compares the JSON shape so a brand-new Set
  // with the same contents doesn't re-run discovery.
  const idsKey = externalIdsArray.slice().sort((a, b) => a - b).join(',');
  useEffect(() => {
    let cancelled = false;
    void loadChipOptions(externalIdsArray).then((next) => {
      if (!cancelled) setOptions(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, discoveryBust]);

  const set = (patch: Partial<AnilistFilterChipState>) =>
    onChipStateChange(patchState(state, patch));

  // Sequential bulk expansion. Cancelled callers get a stale-closure
  // race (the running flag in state guards the button so the user
  // can't double-fire), but we don't AbortController-the-fetches in
  // flight — runAnilistMediaLazyExpansion already coordinates via
  // the worker's scrape lock. After every batch we bump discoveryBust
  // so the chip's VA list reflects newly cached cast incrementally,
  // not just at the end.
  async function bulkExpandUncached(): Promise<void> {
    const uncached = externalIdsArray.filter(
      (id) => !options.cachedCastMediaIds.has(id),
    );
    if (uncached.length === 0) return;
    setBulkExpandStatus({ kind: 'running', done: 0, total: uncached.length });
    let done = 0;
    try {
      for (const id of uncached) {
        await runAnilistMediaLazyExpansion(id);
        done += 1;
        setBulkExpandStatus({
          kind: 'running',
          done,
          total: uncached.length,
        });
        // Refresh the VA option list periodically so the user sees
        // the cache grow. Batching every 5 keeps re-renders from
        // dominating CPU during a long expansion.
        if (done % 5 === 0) setDiscoveryBust((x) => x + 1);
      }
      setBulkExpandStatus({ kind: 'idle' });
      setDiscoveryBust((x) => x + 1);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setBulkExpandStatus({ kind: 'error', message });
      // Still refresh — partial progress matters.
      setDiscoveryBust((x) => x + 1);
    }
  }

  // Chip render order, per the agreed UX:
  //   list status, status, genre, format, year (multiselect),
  //   seasonYear (range), score (range), studio, voice actor,
  //   tag, tag options (mode + rank), exclude tag.
  return (
    <>
      <MultiSelectChip<AnilistMediaListStatus>
        label="list status"
        options={ALL_LIST_STATUSES}
        selected={state.listStatuses}
        onToggle={(v) =>
          set({ listStatuses: toggleInArray(state.listStatuses, v) })
        }
        onReplaceAll={(vals) => set({ listStatuses: [...vals] })}
      />
      <MultiSelectChip
        label="status"
        options={ALL_STATUSES}
        selected={state.statuses}
        onToggle={(v) => set({ statuses: toggleInArray(state.statuses, v) })}
      />
      <MultiSelectChip
        label="genre"
        options={options.genres}
        selected={state.genres}
        onToggle={(v) => set({ genres: toggleInArray(state.genres, v) })}
      />
      <MultiSelectChip
        label="format"
        options={ALL_FORMATS}
        selected={state.formats}
        onToggle={(v) => set({ formats: toggleInArray(state.formats, v) })}
      />
      <MultiSelectChip
        label="year"
        options={options.years}
        selected={state.years}
        onToggle={(v) => set({ years: toggleInArray(state.years, v) })}
      />
      <SeasonYearChip
        options={options.seasonYearEncoded}
        min={state.seasonYearMin}
        max={state.seasonYearMax}
        onChange={(patch) => set(patch)}
      />
      <ScoreRangeChip
        pill={state.userScoreInclude}
        min={state.scoreMin}
        max={state.scoreMax}
        onChange={(patch) => set(patch)}
      />
      <MultiSelectChip<number>
        label="studio"
        options={options.studios.map((s) => s.id)}
        selected={state.studioIds}
        onToggle={(v) =>
          set({ studioIds: toggleInArray(state.studioIds, v) })
        }
        formatOption={(id) =>
          options.studios.find((s) => s.id === id)?.name ?? String(id)
        }
        onReplaceAll={(vals) => set({ studioIds: [...vals] })}
        searchable
        searchPlaceholder="Search studios…"
      />
      <VoiceActorChip
        options={options.voiceActors}
        selected={state.voiceActorIds}
        onToggle={(id) =>
          set({ voiceActorIds: toggleInArray(state.voiceActorIds, id) })
        }
        cachedCount={options.cachedCastMediaIds.size}
        totalCount={externalIdsArray.length}
        onBulkExpand={() => {
          void bulkExpandUncached();
        }}
        bulkExpandStatus={bulkExpandStatus}
      />
      <MultiSelectChip
        label="tag"
        options={options.tagNames}
        selected={state.tagNames}
        onToggle={(v) =>
          set({ tagNames: toggleInArray(state.tagNames, v) })
        }
        onReplaceAll={(vals) => set({ tagNames: [...vals] })}
        searchable
        searchPlaceholder="Search tags…"
      />
      <TagOptionsChip
        mode={state.tagMode}
        minRank={state.tagMinRank}
        onChange={(patch) => set(patch)}
      />
      <MultiSelectChip
        label="exclude tag"
        options={options.tagNames}
        selected={state.tagExclude}
        onToggle={(v) =>
          set({ tagExclude: toggleInArray(state.tagExclude, v) })
        }
        onReplaceAll={(vals) => set({ tagExclude: [...vals] })}
        searchable
        searchPlaceholder="Search tags to exclude…"
      />
    </>
  );
}

// ---------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------

export const anilistFilterModule: SourceFilterModule = {
  initialChipState: () => ({ ...ANILIST_INITIAL_CHIP_STATE }),
  // Return JSX (not a direct function-call) so React owns the hook
  // lifecycle of the AnilistChips component. The FilterBar shell
  // renders this directly as the chip group for the anilist bucket.
  renderChips: (props) => <AnilistChips {...props} />,
  computeAllowed: async (externalIds, chipState) => {
    const ids = Array.from(externalIds, (x) => Number(x));
    const allowed = await computeAllowedMediaIds(
      ids,
      chipState as AnilistFilterChipState,
    );
    return new Set<string | number>(allowed);
  },
  // The AniList chip group ships a non-trivial default (listStatuses
  // pre-selects 3 of 6 enum values) so FilterBar's default
  // shallow-equal check would call the chip "inactive" and skip the
  // actual filtering. Re-use `isInitialState` so the module's own
  // sense of "passthrough" stays the single source of truth.
  isPassthrough: (state) => isInitialState(state as AnilistFilterChipState),
};

// Idempotent UI-side registration. Kept out of `anilistSource.ts`
// because that file is imported by the worker bundle (via
// `db/client.ts`) — pulling React into the worker bundle would be
// wasteful. UI entry (App / start-screen mode loader) calls this once.
let filterModuleRegistered = false;

export function ensureAnilistFiltersRegistered(): void {
  if (filterModuleRegistered) return;
  registerSourceFilters(ANILIST_SOURCE_ID, anilistFilterModule);
  filterModuleRegistered = true;
}
