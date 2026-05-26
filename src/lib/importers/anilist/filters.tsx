/**
 * AniList LIST-tab filter chips. Plugged into the generic
 * [FilterBar](../../../components/FilterBar.tsx) shell via
 * `registerSourceFilters('anilist', ...)` so the LIST tab stays
 * source-agnostic and other importers (Spotify / Steam / ...) can
 * register their own chip modules later without touching this file.
 *
 * Chip set (per AniList plan §C and Phase D plan):
 *   - genre           multi-select OR
 *   - year            single-year buckets (and an "all" fallback)
 *   - format          multi-select OR
 *   - season          multi-select OR
 *   - status          multi-select OR (media.status)
 *   - meanScoreBucket buckets of 10 (0-9, 10-19, ..., 90-100, plus "unrated")
 *   - studio          multi-select OR (matches if media has ANY selected)
 *   - tag             multi-select with mode (OR / AND) + min rank threshold + exclude
 *   - favourited      tri-state: any | only favourited | only unfavourited
 *
 * The filter operates entirely on the media table + its junctions
 * inside `anilist.sqlite`; user-scoping is opportunistic — `favourited`
 * uses the latest known AniList user (`getLatestAnilistUser`) so the
 * chip "just works" without making the slot blob carry user identity.
 * If the DB has zero anilist_user rows (e.g. items in this slot came
 * from an old import that's since been wiped), the favourited chip is
 * a no-op.
 */

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
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
  getFavouritedMediaIds,
  getLatestAnilistUser,
  getMediaByIds,
} from './readQueries';
import type {
  AnilistMediaFormat,
  AnilistMediaSeason,
  AnilistMediaStatus,
} from './types';

// ---------------------------------------------------------------------
// Chip state
//
// Plain JSON-serialisable shape so the FilterBar shell's chipStates
// map can be persisted later without touching this module. Every chip
// defaults to "off" (empty set / 'any' / null) so the initial state
// passes every item through.
// ---------------------------------------------------------------------

export type TagFilterMode = 'or' | 'and';
export type TriState = 'any' | 'yes' | 'no';

export interface AnilistFilterChipState extends FilterChipState {
  genres: string[];
  years: number[];
  formats: AnilistMediaFormat[];
  seasons: AnilistMediaSeason[];
  statuses: AnilistMediaStatus[];
  scoreBuckets: number[]; // 0..9 -> 0-9..90-100; -1 -> unrated
  studioIds: number[];
  tagNames: string[];
  tagMode: TagFilterMode;
  tagMinRank: number; // 0..100; 0 means "any rank"
  tagExclude: string[];
  favourited: TriState;
}

export const ANILIST_INITIAL_CHIP_STATE: AnilistFilterChipState = {
  genres: [],
  years: [],
  formats: [],
  seasons: [],
  statuses: [],
  scoreBuckets: [],
  studioIds: [],
  tagNames: [],
  tagMode: 'or',
  tagMinRank: 0,
  tagExclude: [],
  favourited: 'any',
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
//   - "active" means "the chip's selection is non-empty / non-default".
//     Inactive chips don't contribute any clauses.
//   - Tag mode `'or'` uses `EXISTS` per tag-name; mode `'and'` uses
//     a HAVING COUNT(DISTINCT) trick to require all names matched.
//     Min rank filters the EXISTS subquery so a tag at rank < threshold
//     doesn't count.
//   - `favouritedIds` is read separately (needs a user id) and applied
//     AFTER the SQL filter as a Set intersection — keeps the SQL simple
//     and saves us from threading the user id through the builder.
// ---------------------------------------------------------------------

export interface AnilistFilterSql {
  sql: string;
  params: SqlBindable[];
}

/**
 * Returns null when no chips are active beyond "favourited", which
 * means the caller can skip the SQL round-trip entirely and just
 * intersect with `favouritedIds` (or pass everything through).
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
  if (state.seasons.length > 0) {
    clauses.push(`m.season IN (${placeholders(state.seasons.length)})`);
    params.push(...state.seasons);
  }
  if (state.statuses.length > 0) {
    clauses.push(`m.status IN (${placeholders(state.statuses.length)})`);
    params.push(...state.statuses);
  }

  if (state.scoreBuckets.length > 0) {
    // -1 == "unrated" (mean_score IS NULL). Other values 0..9 map to
    // [N*10, (N+1)*10) — with 9 capturing 90..100 inclusive (AniList's
    // mean_score range tops at 100).
    const rangeClauses: string[] = [];
    for (const b of state.scoreBuckets) {
      if (b === -1) {
        rangeClauses.push(`m.mean_score IS NULL`);
      } else if (b === 9) {
        rangeClauses.push(`(m.mean_score >= ? AND m.mean_score <= ?)`);
        params.push(90, 100);
      } else {
        rangeClauses.push(`(m.mean_score >= ? AND m.mean_score < ?)`);
        params.push(b * 10, (b + 1) * 10);
      }
    }
    clauses.push(`(${rangeClauses.join(' OR ')})`);
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

function isInitialState(state: AnilistFilterChipState): boolean {
  return (
    state.genres.length === 0 &&
    state.years.length === 0 &&
    state.formats.length === 0 &&
    state.seasons.length === 0 &&
    state.statuses.length === 0 &&
    state.scoreBuckets.length === 0 &&
    state.studioIds.length === 0 &&
    state.tagNames.length === 0 &&
    state.tagExclude.length === 0 &&
    state.favourited === 'any'
  );
}

/**
 * Compute the subset of `candidateMediaIds` that pass `state`. Handles
 * the `favourited` tri-state (needs a user-scoped read; uses latest
 * known anilist_user) on top of the pure SQL filter.
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

  // Stage 2: favourited tri-state.
  if (state.favourited !== 'any') {
    const db = defaultDbForFilters();
    const user = await getLatestAnilistUser(db);
    if (user) {
      const favIds = await getFavouritedMediaIds(db, user.id, candidateMediaIds);
      const filtered = new Set<number>();
      for (const id of allowed) {
        const isFav = favIds.has(id);
        if (state.favourited === 'yes' && isFav) filtered.add(id);
        else if (state.favourited === 'no' && !isFav) filtered.add(id);
      }
      allowed = filtered;
    }
    // No anilist_user known -> can't evaluate favourited; degrade to
    // "allow nothing" when 'yes' was requested, "allow everything"
    // otherwise. Honest about the missing data.
    else if (state.favourited === 'yes') {
      allowed = new Set();
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
// chip is a popover-less inline button group to keep the layout
// dependency-free. Heavier filters (tag selector, studio search) open
// inline expanders rather than modals so the bar stays visually
// flat — matches the existing `.chip` look on LIST.
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
const ALL_SEASONS: AnilistMediaSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const ALL_STATUSES: AnilistMediaStatus[] = [
  'FINISHED',
  'RELEASING',
  'NOT_YET_RELEASED',
  'CANCELLED',
  'HIATUS',
];

/**
 * Discovery query: pull the universe of options for chip selectors
 * (genres, years, studios, tag names) FROM the candidate ids actually
 * in the slot. Keeps chip menus relevant — no "filter by Sci-Fi"
 * when the user's slot has zero sci-fi shows.
 */
interface ChipOptions {
  genres: string[];
  years: number[];
  studios: Array<{ id: number; name: string }>;
  tagNames: string[];
}

async function loadChipOptions(
  externalIds: readonly number[],
): Promise<ChipOptions> {
  if (externalIds.length === 0) {
    return { genres: [], years: [], studios: [], tagNames: [] };
  }
  const db = defaultDbForFilters();
  const media = await getMediaByIds(db, externalIds);
  const genres = new Set<string>();
  const years = new Set<number>();
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
  return {
    genres: Array.from(genres).sort((a, b) => a.localeCompare(b)),
    years: Array.from(years).sort((a, b) => b - a),
    studios: studioRows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
    })),
    tagNames: tagRows.map((r) => String(r.tag_name)),
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
  const count = selected.length;
  return (
    <div className={`filter-chip ${count > 0 ? 'active' : ''}`}>
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

function TriStateChip({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TriState;
  onChange: (next: TriState) => void;
}): ReactNode {
  const next: Record<TriState, TriState> = { any: 'yes', yes: 'no', no: 'any' };
  const display: Record<TriState, string> = {
    any: 'any',
    yes: 'only',
    no: 'exclude',
  };
  return (
    <button
      type="button"
      className={`filter-chip ${value !== 'any' ? 'active' : ''}`}
      onClick={() => onChange(next[value])}
      title={`Cycle ${label}: ${display[value]}`}
    >
      {label} · {display[value]}
    </button>
  );
}

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
  });
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
  }, [idsKey]);

  const set = (patch: Partial<AnilistFilterChipState>) =>
    onChipStateChange(patchState(state, patch));

  return (
    <>
      <MultiSelectChip
        label="genre"
        options={options.genres}
        selected={state.genres}
        onToggle={(v) => set({ genres: toggleInArray(state.genres, v) })}
      />
      <MultiSelectChip
        label="year"
        options={options.years}
        selected={state.years}
        onToggle={(v) => set({ years: toggleInArray(state.years, v) })}
      />
      <MultiSelectChip
        label="format"
        options={ALL_FORMATS}
        selected={state.formats}
        onToggle={(v) => set({ formats: toggleInArray(state.formats, v) })}
      />
      <MultiSelectChip
        label="season"
        options={ALL_SEASONS}
        selected={state.seasons}
        onToggle={(v) => set({ seasons: toggleInArray(state.seasons, v) })}
      />
      <MultiSelectChip
        label="status"
        options={ALL_STATUSES}
        selected={state.statuses}
        onToggle={(v) => set({ statuses: toggleInArray(state.statuses, v) })}
      />
      <MultiSelectChip<number>
        label="score"
        options={[-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]}
        selected={state.scoreBuckets}
        onToggle={(v) =>
          set({ scoreBuckets: toggleInArray(state.scoreBuckets, v) })
        }
        formatOption={(b) => {
          if (b === -1) return 'unrated';
          if (b === 9) return '90-100';
          return `${b * 10}-${b * 10 + 9}`;
        }}
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
      <MultiSelectChip
        label={`tag (${state.tagMode})`}
        options={options.tagNames}
        selected={state.tagNames}
        onToggle={(v) =>
          set({ tagNames: toggleInArray(state.tagNames, v) })
        }
      />
      <button
        type="button"
        className="filter-chip"
        onClick={() =>
          set({ tagMode: state.tagMode === 'or' ? 'and' : 'or' })
        }
        title="Toggle tag combination mode"
      >
        tag · {state.tagMode.toUpperCase()}
      </button>
      <label className="filter-chip">
        rank ≥{' '}
        <input
          type="number"
          min={0}
          max={100}
          step={5}
          value={state.tagMinRank}
          onChange={(e) => set({ tagMinRank: Number(e.target.value) || 0 })}
          className="filter-chip-number"
        />
      </label>
      <MultiSelectChip
        label="exclude tag"
        options={options.tagNames}
        selected={state.tagExclude}
        onToggle={(v) =>
          set({ tagExclude: toggleInArray(state.tagExclude, v) })
        }
      />
      <TriStateChip
        label="favourited"
        value={state.favourited}
        onChange={(v) => set({ favourited: v })}
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
