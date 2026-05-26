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
 *   - score           range slider over mean_score (0..100)
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
  // Score range on media.mean_score (0..100). Null bound = unbounded
  // on that side. Both null = chip off.
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
 *  check (functionally equivalent to no filter). */
export const ALL_LIST_STATUSES: AnilistMediaListStatus[] = [
  'CURRENT',
  'PLANNING',
  'COMPLETED',
  'DROPPED',
  'PAUSED',
  'REPEATING',
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

  // Score range. Each bound is emitted independently so a one-sided
  // range (only min OR only max set) doesn't require a magic sentinel.
  if (state.scoreMin !== null) {
    clauses.push(`m.mean_score >= ?`);
    params.push(state.scoreMin);
  }
  if (state.scoreMax !== null) {
    clauses.push(`m.mean_score <= ?`);
    params.push(state.scoreMax);
  }

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
 * For `voiceActorIds`: empty array ⇒ passthrough. Any non-empty
 * selection is active even if every cached VA is selected — there's
 * no "universe size" we can compare against because the cast cache
 * is per-show and partial.
 */
export function isInitialState(state: AnilistFilterChipState): boolean {
  const listStatusActive =
    state.listStatuses.length > 0 &&
    state.listStatuses.length < ALL_LIST_STATUSES.length;
  const scoreActive = state.scoreMin !== null || state.scoreMax !== null;
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
    !scoreActive &&
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
  if (listStatusActive) {
    const db = defaultDbForFilters();
    const user = await getLatestAnilistUser(db);
    if (user) {
      const disallowed = await getMediaIdsWithDisallowedListStatus(
        db,
        user.id,
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
    // No user -> can't evaluate per-user list_entry; leave `allowed`
    // alone (fail open — better to show too much than to show "0
    // items" when the real cause is a stale shared DB with no
    // anilist_user rows).
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

function toggleInArray<T>(arr: readonly T[], value: T): T[] {
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

function MultiSelectChip<T extends string | number>({
  label,
  options,
  selected,
  onToggle,
  formatOption,
}: {
  label: string;
  options: readonly T[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  formatOption?: (value: T) => string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  // Ref wraps the whole chip (trigger + menu) so the outside-click
  // hook recognises a click on the trigger as "inside" — otherwise
  // the same mousedown that opens the menu would also fire the
  // outside-click handler and immediately close it again.
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));
  const count = selected.length;
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
          {options.length === 0 && (
            <div className="filter-chip-empty">(no options)</div>
          )}
          {options.map((opt) => (
            <label key={String(opt)} className="filter-chip-option">
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => onToggle(opt)}
              />
              <span>{formatOption ? formatOption(opt) : String(opt)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Range chip for the season-year filter. The min/max bounds snap to
 * the discrete (season, year) tuples discovered in the candidate
 * set — there's no point letting the user pick "Summer 1997" if no
 * candidate has that season-year. Both selects include an
 * "(any)" option so either bound can be cleared independently.
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
  const label = active ? `seasonYear · ${rangeLabel(min, max, formatSeasonYear)}` : 'seasonYear';

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
        <div className="filter-chip-menu" role="menu">
          {options.length === 0 ? (
            <div className="filter-chip-empty">
              (no candidates have a known season + year)
            </div>
          ) : (
            <>
              <label className="filter-chip-range-row">
                <span>from</span>
                <select
                  value={min ?? ''}
                  onChange={(e) =>
                    onChange({
                      seasonYearMin: e.target.value === '' ? null : Number(e.target.value),
                      seasonYearMax: max,
                    })
                  }
                >
                  <option value="">(any)</option>
                  {options.map((enc) => (
                    <option key={`min-${enc}`} value={enc}>
                      {formatSeasonYear(enc)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-chip-range-row">
                <span>to</span>
                <select
                  value={max ?? ''}
                  onChange={(e) =>
                    onChange({
                      seasonYearMin: min,
                      seasonYearMax: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="">(any)</option>
                  {options.map((enc) => (
                    <option key={`max-${enc}`} value={enc}>
                      {formatSeasonYear(enc)}
                    </option>
                  ))}
                </select>
              </label>
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
 * Range chip for `mean_score`. Pair of number inputs (0..100); either
 * bound can be left blank. Treats blank as "unbounded" — clamping to
 * 0 / 100 would silently widen the user's intended range when they
 * actually wanted "open on this side".
 */
function ScoreRangeChip({
  min,
  max,
  onChange,
}: {
  min: number | null;
  max: number | null;
  onChange: (patch: { scoreMin: number | null; scoreMax: number | null }) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));
  const active = min !== null || max !== null;
  const label = active ? `score · ${rangeLabel(min, max, String)}` : 'score';

  // Local string state for the inputs so users can type freely
  // (e.g. clear the field, type "65") without us coercing "" to 0
  // on every keystroke. Only sync to chip state on blur / Enter or
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
    if (!Number.isFinite(n) || n < 0 || n > 100) return undefined; // reject
    return Math.round(n);
  }

  function commitMin(): void {
    const parsed = parseBound(minText);
    if (parsed === undefined) {
      setMinText(min === null ? '' : String(min));
      return;
    }
    onChange({ scoreMin: parsed, scoreMax: max });
  }
  function commitMax(): void {
    const parsed = parseBound(maxText);
    if (parsed === undefined) {
      setMaxText(max === null ? '' : String(max));
      return;
    }
    onChange({ scoreMin: min, scoreMax: parsed });
  }

  return (
    <div ref={rootRef} className={`filter-chip ${active ? 'active' : ''}`}>
      <button
        type="button"
        className="filter-chip-button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        title="Filter by mean_score range (0–100)"
      >
        {label}
      </button>
      {open && (
        <div className="filter-chip-menu" role="menu">
          <label className="filter-chip-range-row">
            <span>min</span>
            <input
              type="number"
              min={0}
              max={100}
              value={minText}
              onChange={(e) => setMinText(e.target.value)}
              onBlur={commitMin}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="filter-chip-number"
            />
          </label>
          <label className="filter-chip-range-row">
            <span>max</span>
            <input
              type="number"
              min={0}
              max={100}
              value={maxText}
              onChange={(e) => setMaxText(e.target.value)}
              onBlur={commitMax}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="filter-chip-number"
            />
          </label>
          {active && (
            <button
              type="button"
              className="filter-chip-action"
              onClick={() => onChange({ scoreMin: null, scoreMax: null })}
            >
              Clear range
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "60-90" / "≥ 60" / "≤ 90" depending on which bounds are present.
 *  Assumes the caller has already filtered out the both-null case. */
function rangeLabel<T>(
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
