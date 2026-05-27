/**
 * Filter chip modules for AniList CHARACTER and STAFF favourites.
 *
 * These are registered under separate `source.kind`s
 * (`anilist-character`, `anilist-staff`) so the FilterBar partitions
 * character / staff favourites into their own buckets instead of
 * lumping them into the media filter module. Character and staff have
 * no schema overlap with media (no genre, no studio, no mean_score),
 * so a shared "AniList" chip group would be either too narrow (only
 * fields all three share) or too wide (every field disabled for the
 * wrong entity type).
 *
 * The modules are split into two phases:
 *
 *   Phase 1 (entity-local, always usable):
 *     - CHARACTER: gender, favourites range
 *     - STAFF:     gender, favourites range, language
 *
 *   Phase 2 (junction-driven, depends on cached media imports):
 *     - CHARACTER: role, voice actor, appears in media
 *     - STAFF:     voiced in media
 *
 *   Phase 2 chips intentionally do NOT trigger any new GraphQL
 *   fetches. They read whatever's already in the local cache
 *   (`media_character`, `character_voice_actor`) — populated by the
 *   user's media imports + detail expansions. When no junction rows
 *   exist for the candidate set, the chip dropdown reads as "(no
 *   data yet — import or open a related show to populate)" and the
 *   chip stays passthrough until the user toggles something.
 *
 * The chip primitives (MultiSelectChip, DualRangeSlider, etc.) are
 * shared with the media filter module (re-exported from filters.tsx)
 * so the chip group has a consistent look-and-feel across all three
 * source kinds.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import {
  type FilterChipState,
  registerSourceFilters,
  type SourceFilterModule,
} from '../../db/source-registry';
import * as client from '../../db/client';
import { ANILIST_SOURCE_ID } from './anilistSource';
import type { AnilistDbExecutor } from './context';
import {
  DualRangeSlider,
  MultiSelectChip,
  rangeLabel,
  toggleInArray,
} from './filters';
import {
  getCharacterIdsAppearingInMedia,
  getCharacterIdsVoicedByStaff,
  getCharacterIdsWithRoles,
  getCharactersByIds,
  getFavouriteCount,
  getFavouriteRanksForIds,
  getLatestAnilistUser,
  getMediaAppearancesForCharacters,
  getMediaVoicedByStaff,
  getStaffByIds,
  getStaffIdsVoicedInMedia,
  getVoiceActorsByCharacterIds,
  type FavouriteRankEntity,
  type MediaOption,
  type VoiceActorOption,
} from './readQueries';

// ---------------------------------------------------------------------
// Test injection seam (mirrors filters.tsx so chip discovery + filter
// computation run against an in-memory anilist.sqlite during tests).
// ---------------------------------------------------------------------

let injectedDb: AnilistDbExecutor | null = null;

export function setCharacterStaffFilterDbForTesting(
  db: AnilistDbExecutor | null,
): void {
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

// ---------------------------------------------------------------------
// Shared chip primitive: numeric-range chip (used by "favourites" on
// both characters and staff). Same UX as the user-score range on
// media (typed bound inputs + dual-handle slider) but the universe
// max is data-driven (highest favourites count among the candidates)
// instead of a fixed constant.
// ---------------------------------------------------------------------

interface NumericRangeChipProps {
  /** Visible chip label ("favourites", etc.). */
  label: string;
  /** Optional tooltip on the chip button. */
  title?: string;
  /** Slider lower bound (typically 0 or 1). Bound at this value
   *  collapses the min half of the range to null (chip turns off). */
  sliderMin: number;
  /** Slider upper bound — usually `max(candidate.value)`. Bound at
   *  this value collapses the max half to null. */
  sliderMax: number;
  min: number | null;
  max: number | null;
  onChange: (patch: { min: number | null; max: number | null }) => void;
  /** Optional message to show inside the popover when there is no
   *  meaningful range (`sliderMax <= sliderMin`). Defaults to a
   *  generic "no spread" string; the rank chip swaps in
   *  "no favourites cached" since that's a clearer cause for that
   *  particular module. */
  emptyMessage?: string;
}

function NumericRangeChip({
  label,
  title,
  sliderMin,
  sliderMax,
  min,
  max,
  onChange,
  emptyMessage,
}: NumericRangeChipProps): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));
  const active = min !== null || max !== null;
  const chipLabel = active ? `${label} · ${rangeLabel(min, max, String)}` : label;
  const lo = min ?? sliderMin;
  const hi = max ?? sliderMax;

  // Local string state for the typed inputs (same pattern as
  // filters.tsx::ScoreRangeChip — lets users clear / retype freely).
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
    if (!Number.isFinite(n) || n < sliderMin || n > sliderMax) return undefined;
    return Math.round(n);
  }

  function commitMin(): void {
    const parsed = parseBound(minText);
    if (parsed === undefined) {
      setMinText(min === null ? '' : String(min));
      return;
    }
    const collapsed = parsed === sliderMin ? null : parsed;
    const nextMax = max !== null && collapsed !== null && max < collapsed ? collapsed : max;
    onChange({ min: collapsed, max: nextMax });
  }

  function commitMax(): void {
    const parsed = parseBound(maxText);
    if (parsed === undefined) {
      setMaxText(max === null ? '' : String(max));
      return;
    }
    const collapsed = parsed === sliderMax ? null : parsed;
    const nextMin = min !== null && collapsed !== null && min > collapsed ? collapsed : min;
    onChange({ min: nextMin, max: collapsed });
  }

  function onSliderChange([newLo, newHi]: [number, number]): void {
    onChange({
      min: newLo === sliderMin ? null : newLo,
      max: newHi === sliderMax ? null : newHi,
    });
  }

  const hasRange = sliderMax > sliderMin;

  return (
    <div ref={rootRef} className={`filter-chip ${active ? 'active' : ''}`}>
      <button
        type="button"
        className="filter-chip-button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        title={title}
      >
        {chipLabel}
      </button>
      {open && (
        <div className="filter-chip-menu filter-chip-menu-wide" role="menu">
          {!hasRange ? (
            <div className="filter-chip-empty">
              {emptyMessage ?? `(no spread — every candidate has the same ${label})`}
            </div>
          ) : (
            <>
              <div className="filter-chip-slider-row">
                <input
                  type="number"
                  min={sliderMin}
                  max={sliderMax}
                  step={1}
                  value={minText}
                  onChange={(e) => setMinText(e.target.value)}
                  onBlur={commitMin}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className="filter-chip-slider-input"
                  placeholder={String(sliderMin)}
                  aria-label={`${label} minimum`}
                />
                <DualRangeSlider
                  min={sliderMin}
                  max={sliderMax}
                  value={[lo, hi]}
                  onChange={onSliderChange}
                  ariaLabelMin={`${label} range minimum`}
                  ariaLabelMax={`${label} range maximum`}
                />
                <input
                  type="number"
                  min={sliderMin}
                  max={sliderMax}
                  step={1}
                  value={maxText}
                  onChange={(e) => setMaxText(e.target.value)}
                  onBlur={commitMax}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className="filter-chip-slider-input"
                  placeholder={String(sliderMax)}
                  aria-label={`${label} maximum`}
                />
              </div>
              {active && (
                <button
                  type="button"
                  className="filter-chip-action"
                  onClick={() => onChange({ min: null, max: null })}
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

// ---------------------------------------------------------------------
// Shared discovery helpers
// ---------------------------------------------------------------------

/** UNKNOWN gender labels in the AniList data tend to be `null` or
 *  the literal "Unknown". Surface them in the chip as a dedicated
 *  "(unknown)" bucket so users can intentionally include/exclude
 *  them instead of having those rows silently disappear. */
const UNKNOWN_GENDER = '(unknown)';

function normaliseGender(raw: string | null): string {
  if (raw === null) return UNKNOWN_GENDER;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'unknown') {
    return UNKNOWN_GENDER;
  }
  return trimmed;
}

/** Inverse of `normaliseGender` — when filtering, the "(unknown)"
 *  bucket must match BOTH null and the literal "Unknown" so users see
 *  the same rows they saw in the discovery menu. */
function genderMatches(rowGender: string | null, selected: string): boolean {
  const norm = normaliseGender(rowGender);
  return norm === selected;
}

/**
 * Shared post-stage: drop candidates whose favourite rank falls
 * outside [rangeMin, rangeMax]. STRICT semantics — an item not in
 * the favourites table at all is dropped when the chip is active.
 * (The chip exists to slice "top X / 26–50 of MY favourites"; an
 * item that isn't a favourite has no rank to evaluate against.)
 *
 * Fails OPEN when there's no anilist_user cached — matches the
 * listStatuses / user-score chip behaviour so a stale DB doesn't
 * silently produce 0 items.
 */
async function applyFavouriteRankFilter(
  allowed: Set<number>,
  entity: FavouriteRankEntity,
  rangeMin: number | null,
  rangeMax: number | null,
): Promise<Set<number>> {
  if (allowed.size === 0) return allowed;
  if (rangeMin === null && rangeMax === null) return allowed;
  const db = defaultDbForFilters();
  const user = await getLatestAnilistUser(db);
  if (!user) return allowed; // fail open — same as listStatuses/user-score
  const ranks = await getFavouriteRanksForIds(
    db,
    user.id,
    entity,
    Array.from(allowed),
  );
  const next = new Set<number>();
  for (const id of allowed) {
    const rank = ranks.get(id);
    if (rank === undefined) continue; // not a favourite → strict drop
    if (rangeMin !== null && rank < rangeMin) continue;
    if (rangeMax !== null && rank > rangeMax) continue;
    next.add(id);
  }
  return next;
}

// =====================================================================
// CHARACTER filter module
// =====================================================================

interface CharacterFilterChipState extends FilterChipState {
  /** Discovered gender values the user wants to keep (empty = no filter). */
  genders: string[];
  /** Favourites range (`character.favourites`). Both null = no filter. */
  favouritesMin: number | null;
  favouritesMax: number | null;
  /** Per-user favourite-rank range (1-indexed; rank 1 = AniList
   *  favourite #1). STRICT: when set, items not in the favourites
   *  table at all are also dropped. Both null = no filter. */
  favouriteRankMin: number | null;
  favouriteRankMax: number | null;
  /** Phase 2: media-ids the candidate character must appear in
   *  (via `media_character`). Empty = no filter. */
  appearsInMediaIds: number[];
  /** Phase 2: AniList role values
   *  (any of MAIN / SUPPORTING / BACKGROUND). Empty = no filter. */
  roles: string[];
  /** Phase 2: voice-actor staff-ids the character must be voiced by
   *  in at least one cached `character_voice_actor` row. Empty = no
   *  filter. */
  voiceActorIds: number[];
}

const CHARACTER_INITIAL_CHIP_STATE: CharacterFilterChipState = {
  genders: [],
  favouritesMin: null,
  favouritesMax: null,
  favouriteRankMin: null,
  favouriteRankMax: null,
  appearsInMediaIds: [],
  roles: [],
  voiceActorIds: [],
};

const CHARACTER_ROLES = ['MAIN', 'SUPPORTING', 'BACKGROUND'];

function characterIsInitialState(state: CharacterFilterChipState): boolean {
  return (
    state.genders.length === 0 &&
    state.favouritesMin === null &&
    state.favouritesMax === null &&
    state.favouriteRankMin === null &&
    state.favouriteRankMax === null &&
    state.appearsInMediaIds.length === 0 &&
    state.roles.length === 0 &&
    state.voiceActorIds.length === 0
  );
}

interface CharacterChipOptions {
  genders: string[];
  favouritesMax: number;
  /** Total cached favourites for this entity type under the latest
   *  AniList user. Drives the favourite-rank chip's slider universe
   *  (1..N). 0 = "no favourites cached" → chip surfaces that as the
   *  empty-state message. The count is taken from the table, NOT the
   *  candidate set, so the slider always lets you reach into your
   *  full favourites list even when the current preview only shows
   *  a subset. */
  totalFavourites: number;
  // Phase 2 — empty arrays when the user hasn't imported / detail-
  // expanded any related media. The chip menus surface that emptiness
  // explicitly so the missing-data case isn't silent.
  mediaOptions: MediaOption[];
  voiceActors: VoiceActorOption[];
}

async function loadCharacterChipOptions(
  characterIds: readonly number[],
): Promise<CharacterChipOptions> {
  if (characterIds.length === 0) {
    return {
      genders: [],
      favouritesMax: 0,
      totalFavourites: 0,
      mediaOptions: [],
      voiceActors: [],
    };
  }
  const db = defaultDbForFilters();
  const user = await getLatestAnilistUser(db);
  const [chars, mediaOptions, voiceActors, totalFavourites] = await Promise.all([
    getCharactersByIds(db, characterIds),
    getMediaAppearancesForCharacters(db, characterIds),
    getVoiceActorsByCharacterIds(db, characterIds),
    user ? getFavouriteCount(db, user.id, 'CHARACTERS') : Promise.resolve(0),
  ]);
  const genders = new Set<string>();
  let favouritesMax = 0;
  for (const c of chars) {
    genders.add(normaliseGender(c.gender));
    if (c.favourites !== null && c.favourites > favouritesMax) {
      favouritesMax = c.favourites;
    }
  }
  return {
    // "(unknown)" floats to the bottom of the list — usually the
    // least-interesting bucket for filtering on.
    genders: Array.from(genders).sort((a, b) => {
      if (a === UNKNOWN_GENDER) return 1;
      if (b === UNKNOWN_GENDER) return -1;
      return a.localeCompare(b);
    }),
    favouritesMax,
    totalFavourites,
    mediaOptions,
    voiceActors,
  };
}

async function computeAllowedCharacterIds(
  characterIds: readonly number[],
  state: CharacterFilterChipState,
): Promise<Set<number>> {
  if (characterIds.length === 0) return new Set();
  if (characterIsInitialState(state)) {
    return new Set(characterIds);
  }
  const db = defaultDbForFilters();

  // Stage 1: per-entity filters (gender, favourites). These only need
  // the character row itself, so we batch a single fetch and apply
  // both predicates in-memory. Cheaper than two SQL round-trips and
  // makes the "favourites null → not in any range" semantics explicit.
  let allowed = new Set<number>(characterIds);
  const needsRow =
    state.genders.length > 0 ||
    state.favouritesMin !== null ||
    state.favouritesMax !== null;
  if (needsRow) {
    const chars = await getCharactersByIds(db, characterIds);
    const next = new Set<number>();
    const allowedGenders =
      state.genders.length > 0 ? new Set(state.genders) : null;
    for (const c of chars) {
      if (allowedGenders) {
        const matches = Array.from(allowedGenders).some((g) =>
          genderMatches(c.gender, g),
        );
        if (!matches) continue;
      }
      if (state.favouritesMin !== null || state.favouritesMax !== null) {
        // Rows with null favourites can't satisfy a numeric range —
        // drop them. Matches the user's mental model ("filter by
        // favourites count" doesn't apply to rows we don't have a
        // count for).
        if (c.favourites === null) continue;
        if (state.favouritesMin !== null && c.favourites < state.favouritesMin) continue;
        if (state.favouritesMax !== null && c.favourites > state.favouritesMax) continue;
      }
      next.add(c.id);
    }
    allowed = next;
  }

  if (allowed.size === 0) return allowed;
  const allowedArr = Array.from(allowed);

  // Stage 2: junction filters. Each runs only when active; an active
  // chip with NO matching junction rows drops everything (correct
  // semantics: "show only characters who appear in [media X]" must
  // produce 0 results when the cache has no media_character rows for
  // X, not silently pass through).
  if (state.roles.length > 0) {
    const matched = await getCharacterIdsWithRoles(
      db,
      allowedArr,
      state.roles,
    );
    allowed = intersect(allowed, matched);
  }
  if (allowed.size > 0 && state.appearsInMediaIds.length > 0) {
    const matched = await getCharacterIdsAppearingInMedia(
      db,
      Array.from(allowed),
      state.appearsInMediaIds,
    );
    allowed = intersect(allowed, matched);
  }
  if (allowed.size > 0 && state.voiceActorIds.length > 0) {
    const matched = await getCharacterIdsVoicedByStaff(
      db,
      Array.from(allowed),
      state.voiceActorIds,
    );
    allowed = intersect(allowed, matched);
  }
  // Favourite-rank post-stage. Runs LAST so prior gender/junction
  // filters narrow the set the rank lookup has to score against — and
  // so we don't waste a DB round-trip when those stages already
  // produced 0 rows.
  allowed = await applyFavouriteRankFilter(
    allowed,
    'CHARACTERS',
    state.favouriteRankMin,
    state.favouriteRankMax,
  );
  return allowed;
}

function intersect(a: Set<number>, b: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const v of a) {
    if (b.has(v)) out.add(v);
  }
  return out;
}

interface ChipsHostProps {
  externalIds: ReadonlySet<string | number>;
  chipState: FilterChipState;
  onChipStateChange: (patch: FilterChipState) => void;
}

function CharacterChips({
  externalIds,
  chipState,
  onChipStateChange,
}: ChipsHostProps): ReactNode {
  const state = chipState as CharacterFilterChipState;
  const externalIdsArray = Array.from(externalIds, (x) => Number(x));
  const [options, setOptions] = useState<CharacterChipOptions>({
    genders: [],
    favouritesMax: 0,
    totalFavourites: 0,
    mediaOptions: [],
    voiceActors: [],
  });
  const idsKey = externalIdsArray.slice().sort((a, b) => a - b).join(',');
  useEffect(() => {
    let cancelled = false;
    void loadCharacterChipOptions(externalIdsArray).then((next) => {
      if (!cancelled) setOptions(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const set = (patch: Partial<CharacterFilterChipState>) =>
    onChipStateChange({ ...state, ...patch });

  return (
    <>
      <MultiSelectChip<string>
        label="gender"
        options={options.genders}
        selected={state.genders}
        onToggle={(v) => set({ genders: toggleInArray(state.genders, v) })}
        onReplaceAll={(vals) => set({ genders: [...vals] })}
      />
      <NumericRangeChip
        label="favourites"
        title="Filter by AniList favourites count"
        sliderMin={0}
        sliderMax={options.favouritesMax}
        min={state.favouritesMin}
        max={state.favouritesMax}
        onChange={(patch) =>
          set({ favouritesMin: patch.min, favouritesMax: patch.max })
        }
      />
      <NumericRangeChip
        label="rank"
        title="Filter by YOUR favourite rank (1 = your #1 favourite character). Strict: items not in your favourites are dropped when this is set."
        sliderMin={1}
        sliderMax={options.totalFavourites}
        min={state.favouriteRankMin}
        max={state.favouriteRankMax}
        onChange={(patch) =>
          set({ favouriteRankMin: patch.min, favouriteRankMax: patch.max })
        }
        emptyMessage="(no favourites cached — load your AniList favourites first)"
      />
      <MultiSelectChip<string>
        label="role"
        options={CHARACTER_ROLES}
        selected={state.roles}
        onToggle={(v) => set({ roles: toggleInArray(state.roles, v) })}
        onReplaceAll={(vals) => set({ roles: [...vals] })}
      />
      <MultiSelectChip<number>
        label="appears in"
        options={options.mediaOptions.map((m) => m.id)}
        selected={state.appearsInMediaIds}
        onToggle={(v) =>
          set({ appearsInMediaIds: toggleInArray(state.appearsInMediaIds, v) })
        }
        formatOption={(id) =>
          options.mediaOptions.find((m) => m.id === id)?.title ?? String(id)
        }
        onReplaceAll={(vals) => set({ appearsInMediaIds: [...vals] })}
        searchable
        searchPlaceholder="Search media…"
      />
      <MultiSelectChip<number>
        label="voice actor"
        options={options.voiceActors.map((v) => v.id)}
        selected={state.voiceActorIds}
        onToggle={(v) =>
          set({ voiceActorIds: toggleInArray(state.voiceActorIds, v) })
        }
        formatOption={(id) =>
          options.voiceActors.find((v) => v.id === id)?.name ?? String(id)
        }
        onReplaceAll={(vals) => set({ voiceActorIds: [...vals] })}
        searchable
        searchPlaceholder="Search voice actors…"
      />
    </>
  );
}

export const characterFilterModule: SourceFilterModule = {
  initialChipState: () => ({ ...CHARACTER_INITIAL_CHIP_STATE }),
  renderChips: (props) => <CharacterChips {...props} />,
  computeAllowed: async (externalIds, chipState) => {
    const ids = Array.from(externalIds, (x) => Number(x));
    const allowed = await computeAllowedCharacterIds(
      ids,
      chipState as CharacterFilterChipState,
    );
    return new Set<string | number>(allowed);
  },
  isPassthrough: (state) =>
    characterIsInitialState(state as CharacterFilterChipState),
};

// =====================================================================
// STAFF filter module
// =====================================================================

interface StaffFilterChipState extends FilterChipState {
  genders: string[];
  favouritesMin: number | null;
  favouritesMax: number | null;
  /** Per-user favourite-rank range (1-indexed). STRICT: items not in
   *  the favourites table are dropped when set. See
   *  `applyFavouriteRankFilter`. */
  favouriteRankMin: number | null;
  favouriteRankMax: number | null;
  /** `staff.language_v2` values to keep. Empty = no filter. */
  languages: string[];
  /** Phase 2: media-ids where the staff member must have voiced at
   *  least one character (via `character_voice_actor`). */
  voicedInMediaIds: number[];
}

const STAFF_INITIAL_CHIP_STATE: StaffFilterChipState = {
  genders: [],
  favouritesMin: null,
  favouritesMax: null,
  favouriteRankMin: null,
  favouriteRankMax: null,
  languages: [],
  voicedInMediaIds: [],
};

function staffIsInitialState(state: StaffFilterChipState): boolean {
  return (
    state.genders.length === 0 &&
    state.favouritesMin === null &&
    state.favouritesMax === null &&
    state.favouriteRankMin === null &&
    state.favouriteRankMax === null &&
    state.languages.length === 0 &&
    state.voicedInMediaIds.length === 0
  );
}

const UNKNOWN_LANGUAGE = '(unknown)';

function normaliseLanguage(raw: string | null): string {
  if (raw === null) return UNKNOWN_LANGUAGE;
  const trimmed = raw.trim();
  if (trimmed === '') return UNKNOWN_LANGUAGE;
  return trimmed;
}

function languageMatches(rowLang: string | null, selected: string): boolean {
  return normaliseLanguage(rowLang) === selected;
}

interface StaffChipOptions {
  genders: string[];
  favouritesMax: number;
  /** See `CharacterChipOptions.totalFavourites` — same semantics, but
   *  counts `staff_favourite` rows for the latest AniList user. */
  totalFavourites: number;
  languages: string[];
  voicedInMedia: MediaOption[];
}

async function loadStaffChipOptions(
  staffIds: readonly number[],
): Promise<StaffChipOptions> {
  if (staffIds.length === 0) {
    return {
      genders: [],
      favouritesMax: 0,
      totalFavourites: 0,
      languages: [],
      voicedInMedia: [],
    };
  }
  const db = defaultDbForFilters();
  const user = await getLatestAnilistUser(db);
  const [rows, voicedInMedia, totalFavourites] = await Promise.all([
    getStaffByIds(db, staffIds),
    getMediaVoicedByStaff(db, staffIds),
    user ? getFavouriteCount(db, user.id, 'STAFF') : Promise.resolve(0),
  ]);
  const genders = new Set<string>();
  const languages = new Set<string>();
  let favouritesMax = 0;
  for (const r of rows) {
    genders.add(normaliseGender(r.gender));
    languages.add(normaliseLanguage(r.language_v2));
    if (r.favourites !== null && r.favourites > favouritesMax) {
      favouritesMax = r.favourites;
    }
  }
  return {
    genders: Array.from(genders).sort((a, b) => {
      if (a === UNKNOWN_GENDER) return 1;
      if (b === UNKNOWN_GENDER) return -1;
      return a.localeCompare(b);
    }),
    favouritesMax,
    totalFavourites,
    languages: Array.from(languages).sort((a, b) => {
      if (a === UNKNOWN_LANGUAGE) return 1;
      if (b === UNKNOWN_LANGUAGE) return -1;
      return a.localeCompare(b);
    }),
    voicedInMedia,
  };
}

async function computeAllowedStaffIds(
  staffIds: readonly number[],
  state: StaffFilterChipState,
): Promise<Set<number>> {
  if (staffIds.length === 0) return new Set();
  if (staffIsInitialState(state)) {
    return new Set(staffIds);
  }
  const db = defaultDbForFilters();
  let allowed = new Set<number>(staffIds);

  const needsRow =
    state.genders.length > 0 ||
    state.languages.length > 0 ||
    state.favouritesMin !== null ||
    state.favouritesMax !== null;
  if (needsRow) {
    const rows = await getStaffByIds(db, staffIds);
    const next = new Set<number>();
    const allowedGenders =
      state.genders.length > 0 ? new Set(state.genders) : null;
    const allowedLanguages =
      state.languages.length > 0 ? new Set(state.languages) : null;
    for (const r of rows) {
      if (allowedGenders) {
        const matches = Array.from(allowedGenders).some((g) =>
          genderMatches(r.gender, g),
        );
        if (!matches) continue;
      }
      if (allowedLanguages) {
        const matches = Array.from(allowedLanguages).some((l) =>
          languageMatches(r.language_v2, l),
        );
        if (!matches) continue;
      }
      if (state.favouritesMin !== null || state.favouritesMax !== null) {
        if (r.favourites === null) continue;
        if (state.favouritesMin !== null && r.favourites < state.favouritesMin) continue;
        if (state.favouritesMax !== null && r.favourites > state.favouritesMax) continue;
      }
      next.add(r.id);
    }
    allowed = next;
  }

  if (allowed.size > 0 && state.voicedInMediaIds.length > 0) {
    const matched = await getStaffIdsVoicedInMedia(
      db,
      Array.from(allowed),
      state.voicedInMediaIds,
    );
    allowed = intersect(allowed, matched);
  }
  // Favourite-rank post-stage — see character module for the
  // rationale on order. Same strict / fail-open semantics.
  allowed = await applyFavouriteRankFilter(
    allowed,
    'STAFF',
    state.favouriteRankMin,
    state.favouriteRankMax,
  );
  return allowed;
}

function StaffChips({
  externalIds,
  chipState,
  onChipStateChange,
}: ChipsHostProps): ReactNode {
  const state = chipState as StaffFilterChipState;
  const externalIdsArray = Array.from(externalIds, (x) => Number(x));
  const [options, setOptions] = useState<StaffChipOptions>({
    genders: [],
    favouritesMax: 0,
    totalFavourites: 0,
    languages: [],
    voicedInMedia: [],
  });
  const idsKey = externalIdsArray.slice().sort((a, b) => a - b).join(',');
  useEffect(() => {
    let cancelled = false;
    void loadStaffChipOptions(externalIdsArray).then((next) => {
      if (!cancelled) setOptions(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const set = (patch: Partial<StaffFilterChipState>) =>
    onChipStateChange({ ...state, ...patch });

  return (
    <>
      <MultiSelectChip<string>
        label="gender"
        options={options.genders}
        selected={state.genders}
        onToggle={(v) => set({ genders: toggleInArray(state.genders, v) })}
        onReplaceAll={(vals) => set({ genders: [...vals] })}
      />
      <NumericRangeChip
        label="favourites"
        title="Filter by AniList favourites count"
        sliderMin={0}
        sliderMax={options.favouritesMax}
        min={state.favouritesMin}
        max={state.favouritesMax}
        onChange={(patch) =>
          set({ favouritesMin: patch.min, favouritesMax: patch.max })
        }
      />
      <NumericRangeChip
        label="rank"
        title="Filter by YOUR favourite rank (1 = your #1 favourite staff). Strict: items not in your favourites are dropped when this is set."
        sliderMin={1}
        sliderMax={options.totalFavourites}
        min={state.favouriteRankMin}
        max={state.favouriteRankMax}
        onChange={(patch) =>
          set({ favouriteRankMin: patch.min, favouriteRankMax: patch.max })
        }
        emptyMessage="(no favourites cached — load your AniList favourites first)"
      />
      <MultiSelectChip<string>
        label="language"
        options={options.languages}
        selected={state.languages}
        onToggle={(v) => set({ languages: toggleInArray(state.languages, v) })}
        onReplaceAll={(vals) => set({ languages: [...vals] })}
        searchable
        searchPlaceholder="Search languages…"
      />
      <MultiSelectChip<number>
        label="voiced in"
        options={options.voicedInMedia.map((m) => m.id)}
        selected={state.voicedInMediaIds}
        onToggle={(v) =>
          set({ voicedInMediaIds: toggleInArray(state.voicedInMediaIds, v) })
        }
        formatOption={(id) =>
          options.voicedInMedia.find((m) => m.id === id)?.title ?? String(id)
        }
        onReplaceAll={(vals) => set({ voicedInMediaIds: [...vals] })}
        searchable
        searchPlaceholder="Search media…"
      />
    </>
  );
}

export const staffFilterModule: SourceFilterModule = {
  initialChipState: () => ({ ...STAFF_INITIAL_CHIP_STATE }),
  renderChips: (props) => <StaffChips {...props} />,
  computeAllowed: async (externalIds, chipState) => {
    const ids = Array.from(externalIds, (x) => Number(x));
    const allowed = await computeAllowedStaffIds(
      ids,
      chipState as StaffFilterChipState,
    );
    return new Set<string | number>(allowed);
  },
  isPassthrough: (state) =>
    staffIsInitialState(state as StaffFilterChipState),
};

// ---------------------------------------------------------------------
// Registration. Keyed on the source.kind that AnilistStartMode tags
// character + staff favourites with. UI entry calls this once at
// startup (alongside ensureAnilistFiltersRegistered).
// ---------------------------------------------------------------------

let registered = false;

export function ensureCharacterStaffFiltersRegistered(): void {
  if (registered) return;
  registerSourceFilters('anilist-character', characterFilterModule);
  registerSourceFilters('anilist-staff', staffFilterModule);
  registered = true;
}

// Exports for tests
export {
  CHARACTER_INITIAL_CHIP_STATE,
  STAFF_INITIAL_CHIP_STATE,
  characterIsInitialState,
  staffIsInitialState,
  computeAllowedCharacterIds,
  computeAllowedStaffIds,
  type CharacterFilterChipState,
  type StaffFilterChipState,
};
