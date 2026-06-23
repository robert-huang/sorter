import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilterBar } from './FilterBar';
import { ItemThumb } from './ItemThumb';
import type { Item, ItemId } from '../lib/types';
import {
  buildAnilistFavouriteUrl,
  buildAnilistMediaUrl,
} from '../lib/importers/anilist/anilistSource';
import {
  mediaLabelSourceFromRow,
  itemMatchesSearch,
  relabelAnilistItem,
  resolveAnilistItemLabel,
} from '../lib/importers/anilist/anilistItemLabel';
import {
  formatMediaDisplayLabel,
  mediaTitleSearchParts,
} from '../lib/importers/anilist/mediaDisplayLabel';
import { useAnilistDisplayPreferences } from '../hooks/useAnilistDisplayPreferences';
import {
  AnilistScrapeLockHeldError,
  AnilistUnknownUserError,
} from '../lib/importers/anilist/importer';
import type { AnilistProgressEvent } from '../lib/importers/anilist/progress';
import {
  productionReads,
  type FavouriteAsItem,
} from '../lib/importers/anilist/readQueries';
import {
  runAnilistFavourites,
  runAnilistImport,
} from '../lib/importers/anilist/runners';
import type {
  AnilistFavouriteType,
  AnilistMediaType,
  MediaRow,
} from '../lib/importers/anilist/types';
import { formatAnilistProgress } from './anilistProgressLabel';
import {
  readLastAnilistUsername,
  writeLastAnilistUsername,
} from '../lib/importers/anilist/lastUsername';

/**
 * StartScreen "anilist" tab content. Owns the full import-and-pick
 * flow:
 *
 *   1. Username + ANIME/MANGA radio + Refresh.
 *   2. While importing: per-page progress hint.
 *   3. On success: pull every imported media row out of anilist.sqlite,
 *      hand them to the cross-source FilterBar, render a preview list
 *      with per-row checkboxes (default all-checked).
 *   4. "Add N to staged" CTA → calls onAddToStaged with each
 *      selected media materialised as an Item carrying
 *      `source: { kind: 'anilist', externalId: media.id }` and a
 *      `<username>/<type>` source label so the staged-items panel
 *      can identify the AniList group amongst other inputs.
 *
 * Username is captured per-action and not persisted as a setting,
 * matching the Phase D locked decision. localStorage holds the
 * "last typed" value as a default-fill convenience — written only on
 * a successful import so a typo never overwrites the last good value.
 */

const ANILIST_FORMAT_IN_LABEL_LS_KEY = 'anilist:includeFormatInLabel';

function readIncludeFormatInLabel(): boolean {
  try {
    return localStorage.getItem(ANILIST_FORMAT_IN_LABEL_LS_KEY) === '1';
  } catch {
    return false;
  }
}

function isMediaFavouriteType(
  t: AnilistFavouriteType,
): t is 'ANIME' | 'MANGA' {
  return t === 'ANIME' || t === 'MANGA';
}

const FAVOURITE_TYPES: AnilistFavouriteType[] = [
  'CHARACTERS',
  'STAFF',
  'STUDIOS',
  'ANIME',
  'MANGA',
];

function favouriteLabel(t: AnilistFavouriteType): string {
  switch (t) {
    case 'CHARACTERS':
      return 'Characters';
    case 'STAFF':
      return 'Staff';
    case 'STUDIOS':
      return 'Studios';
    case 'ANIME':
      return 'Anime';
    case 'MANGA':
      return 'Manga';
  }
}

/** Short relative-time label for "refreshed Xm ago" hints. Single source
 *  of truth between the import row and the favourites row so the
 *  formatting stays consistent. */
function timeAgo(ms: number | null): string {
  if (ms === null) return 'never';
  const delta = Math.max(0, Date.now() - ms);
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}

interface Props {
  /**
   * Called when the user confirms a selection via "Add to staged".
   * Items carry `source: { kind: 'anilist', externalId }` so the
   * LIST tab can open the detail modal + the FilterBar can render
   * chips. `sourceLabel` is shown verbatim in the staged-items panel
   * (e.g. `AniList: robert/anime`).
   */
  onAddToStaged: (items: Item[], sourceLabel: string) => void;
  /** Fired when the user types into the input — used by the parent
   *  to park any loaded session so the import lands in a fresh slot. */
  onDraftActivity: () => void;
  /**
   * Bumped by App.tsx after any push / pull / dirty-bump on the source
   * DB. Folded into the two cache-hint lookup effects' dep arrays so a
   * Drive pull (which replaces the DB but doesn't touch importTick /
   * favTick) still refreshes the "Cached: N items" hint + the
   * favourites counts. Without this, a second tab in memory-mode that
   * pulls from Drive would have data in the DB but the UI would
   * continue to render "no cache".
   */
  dbSyncRevision: number;
}

/**
 * Materialise a MediaRow into an Item ready to seed the sorter. The
 * Item id is the AniList media id stringified — stable, collision-
 * proof across sources because of the source discriminator, and
 * compact in the autosave blob.
 */
function mediaRowToItem(m: MediaRow, includeFormatInLabel: boolean): Item {
  return {
    id: `anilist:${m.id}`,
    label: formatMediaDisplayLabel(m, m.format, includeFormatInLabel),
    searchTokens: mediaTitleSearchParts(m),
    anilistLabelSource: mediaLabelSourceFromRow(m),
    // Auto-populate the canonical AniList entry URL so the staged-
    // items panel + result rows can render a clickable link to the
    // original page (matches how CSV / clipboard items carry a url).
    // The MediaRow already knows its type, so we don't need to plumb
    // the StartScreen's selected ANIME/MANGA radio down here — that
    // would break for mixed-type rows in a future "search across
    // anime + manga" flow.
    url: buildAnilistMediaUrl(m.type, m.id),
    imageUrl: m.cover_image ?? undefined,
    source: { kind: 'anilist', externalId: m.id },
  };
}

/**
 * Materialise an AniList favourite into a sorter Item. ANIME/MANGA
 * favourites get the same id scheme + AniList `source` binding as
 * list-imported media so the LIST tab's filter chips + detail modal
 * keep working — and the dedup set collapses a media that's BOTH on
 * the user's list AND in their favourites down to one item. CHARACTERS
 * / STAFF get their own `source.kind` (`anilist-character` / `anilist-
 * staff`) so the FilterBar partitions them into separate buckets and
 * routes them to character-/staff-specific filter modules (gender,
 * favourites, language, etc.) rather than the media chip module
 * which has no schema overlap. The kind-prefixed id (`anilist-staff:42`)
 * keeps a character #100 and a staff #100 from colliding in the
 * staged-items panel.
 *
 * STUDIOS stay source-less for now: there's no studio filter module
 * registered, and `getItemSourceKind` returns 'manual' for items
 * without a `source` field — so studio favourites just pass through
 * the filter bar untouched, which is the correct behaviour for an
 * entity type we don't filter on.
 */
function favouriteMediaLabel(
  fa: FavouriteAsItem,
  includeFormatInLabel: boolean,
): string {
  if (fa.anilistLabelSource?.kind === 'media') {
    return resolveAnilistItemLabel(fa.anilistLabelSource, includeFormatInLabel);
  }
  if (!includeFormatInLabel || !fa.format) {
    return fa.label;
  }
  return `${fa.label} (${fa.format})`;
}

function favouriteAsItemToItem(
  fa: FavouriteAsItem,
  type: AnilistFavouriteType,
  includeFormatInLabel: boolean,
): Item {
  const url = buildAnilistFavouriteUrl(type, fa.externalId);
  if (type === 'ANIME' || type === 'MANGA') {
    return {
      id: `anilist:${fa.externalId}`,
      label: favouriteMediaLabel(fa, includeFormatInLabel),
      url,
      imageUrl: fa.imageUrl ?? undefined,
      source: { kind: 'anilist', externalId: fa.externalId },
      searchTokens: fa.searchTokens,
      anilistLabelSource: fa.anilistLabelSource,
    };
  }
  if (type === 'CHARACTERS') {
    return {
      id: `anilist-character:${fa.externalId}`,
      label: fa.anilistLabelSource
        ? resolveAnilistItemLabel(fa.anilistLabelSource, false)
        : fa.label,
      url,
      imageUrl: fa.imageUrl ?? undefined,
      source: { kind: 'anilist-character', externalId: fa.externalId },
      searchTokens: fa.searchTokens,
      anilistLabelSource: fa.anilistLabelSource,
    };
  }
  if (type === 'STAFF') {
    return {
      id: `anilist-staff:${fa.externalId}`,
      label: fa.anilistLabelSource
        ? resolveAnilistItemLabel(fa.anilistLabelSource, false)
        : fa.label,
      url,
      imageUrl: fa.imageUrl ?? undefined,
      source: { kind: 'anilist-staff', externalId: fa.externalId },
      searchTokens: fa.searchTokens,
      anilistLabelSource: fa.anilistLabelSource,
    };
  }
  // STUDIOS — no filter module registered; ship as source-less so the
  // FilterBar treats it as manual passthrough.
  const kindSlug = type.toLowerCase();
  return {
    id: `anilist-${kindSlug}:${fa.externalId}`,
    label: fa.label,
    url,
    imageUrl: fa.imageUrl ?? undefined,
    searchTokens: fa.searchTokens,
  };
}

/**
 * Identity of the data currently rendered in the candidate preview.
 * Drives the source-label on `onAddSelectedToStaged` (`AniList:
 * alice/anime` vs `AniList favourites: alice/staff`) and disambiguates
 * the "what cache are we showing?" question when both list + favourites
 * cache hints are visible. Null when nothing has been loaded yet.
 */
type CandidateSource =
  | { kind: 'list'; userId: number; canonicalName: string; type: AnilistMediaType }
  | {
      kind: 'favourites';
      userId: number;
      canonicalName: string;
      type: AnilistFavouriteType;
    };

export function AnilistStartMode({
  onAddToStaged,
  onDraftActivity,
  dbSyncRevision,
}: Props) {
  const [username, setUsername] = useState<string>(readLastAnilistUsername);
  const [type, setType] = useState<AnilistMediaType>('ANIME');
  const [includeFormatInLabel, setIncludeFormatInLabel] = useState<boolean>(
    readIncludeFormatInLabel,
  );
  const { prefs: displayPrefs } = useAnilistDisplayPreferences();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Latest progress event from the in-flight import OR favourites
  // refresh. They share one slot because the scrape lock serializes
  // them at the importer layer, so only one can be in-flight at a
  // time. Null when idle — the bar collapses back to "Importing…"
  // when an event hasn't been emitted yet (brief window before
  // resolve-user fires).
  const [progress, setProgress] = useState<AnilistProgressEvent | null>(null);
  // Soft confirmation surface for "happy but unusual" outcomes. The
  // primary case is "import succeeded but the AniList list/favourites
  // were empty" — that's a legitimate refresh result (brand-new user,
  // user unfavourited everything, hidden list) and silently doing
  // nothing would feel like the import failed. We show it next to
  // `error` and clear it at the start of the next action so it never
  // out-lives the user's attention.
  const [notice, setNotice] = useState<string | null>(null);
  // The candidate preview's underlying item set. Replaces the previous
  // `media: MediaRow[]` shape so a single state slot can hold EITHER
  // list-imported media OR favourites-as-items — both flow through the
  // same FilterBar + checkbox preview + "Add N selected to staged"
  // pipeline. `candidateSource` carries the identity of what was
  // loaded so `onAddSelectedToStaged` can build the right sourceLabel
  // (`AniList: alice/anime` vs `AniList favourites: alice/staff`) and
  // a future enhancement could surface "currently showing: X" in the
  // preview header.
  const [candidates, setCandidates] = useState<Item[]>([]);
  const [candidateSource, setCandidateSource] = useState<CandidateSource | null>(
    null,
  );
  // Favourites refresh state. Lives next to the import flow because
  // it shares the scrape lock and uses the same username from the
  // input above. Refreshing favourites doesn't produce items to sort
  // — it just enriches the cache so the favourite filter chip and
  // detail modal can render rich data.
  const [favType, setFavType] = useState<AnilistFavouriteType>('CHARACTERS');
  const [refreshingFavs, setRefreshingFavs] = useState(false);
  // Per-favourite-type last-refresh timestamp (null when never
  // refreshed locally). Reloaded after every successful refresh so
  // the "refreshed Xm ago" hint stays current.
  const [favouriteRefreshTs, setFavouriteRefreshTs] = useState<
    Record<AnilistFavouriteType, number | null>
  >({
    CHARACTERS: null,
    STAFF: null,
    STUDIOS: null,
    ANIME: null,
    MANGA: null,
  });
  // Bumped to re-trigger the per-favourite-type timestamp load
  // (after a successful favourites refresh). Separate from
  // `importTick` so a media import doesn't also re-read favourites
  // timestamps (cheap but pointless).
  const [favTick, setFavTick] = useState(0);
  // Per-row selection. Drives the "Sort N selected items" CTA's count
  // and the final items[] handed to onAddToStaged. Defaults to "all
  // checked" after each import — the most common intent is "sort
  // everything I just refreshed", and unchecking is easier than
  // checking 600 boxes.
  const [selectedIds, setSelectedIds] = useState<Set<ItemId>>(new Set());
  // Output of the FilterBar — null means "no filter active" (all
  // visible). Computed downstream of `candidates`, so a fresh import
  // or favourites refresh resets it implicitly via the FilterBar's
  // own state.
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<ItemId> | null>(
    null,
  );
  // Live label search — narrows the preview AFTER the FilterBar's
  // chip-driven filter (substring, case-insensitive). Kept local to
  // this component because it's a per-render quick filter that has
  // nothing to do with the source-registry SQL chips; sliding it
  // through the FilterBar's `computeAllowed` would force every chip
  // module to re-run on every keystroke. Cleared after a new import
  // so the preview never opens already-filtered behind the user's
  // back.
  const [search, setSearch] = useState<string>('');
  // Cache-aware hint for the typed (username, type) pair. Populated by
  // the debounced effect below. Null means "we haven't found a cached
  // list for this combo" — UI hides the "Use cached" button and shows
  // a plain "Import" CTA. Non-null lets the user skip the API round
  // trip and load the previously-imported items directly.
  const [cachedListInfo, setCachedListInfo] = useState<{
    /**
     * The exact (trimmed) username + type the lookup ran for. Stored
     * alongside the result so the effect can synchronously clear a
     * stale hint when either the input or the ANIME/MANGA radio
     * changes — without this the previous (`alice`, ANIME) hint
     * would linger on screen for ~300ms while the new (`bob`, ANIME)
     * debounce timer counts down.
     */
    lookupName: string;
    lookupType: AnilistMediaType;
    userId: number;
    canonicalName: string;
    count: number;
    refreshedAt: number | null;
  } | null>(null);
  // Favourites count cache, keyed by type. Drives the
  // "+ Add N favourites to staged" button so the user can see what's
  // available before clicking. Populated when the favourites refresh
  // timestamps load — both depend on the latest imported user.
  const [favouriteCounts, setFavouriteCounts] = useState<
    Record<AnilistFavouriteType, number>
  >({
    CHARACTERS: 0,
    STAFF: 0,
    STUDIOS: 0,
    ANIME: 0,
    MANGA: 0,
  });
  // Identity stamp for the user that the favourites cache effect
  // last resolved. Lets us derive the "Cached: N favourites · Use
  // cached" hint synchronously in render — the hint shows iff the
  // currently-typed username matches what the effect resolved (or is
  // empty and we're using the latest-imported fallback). Mirrors the
  // `lookupName/lookupType` stamps on `cachedListInfo` for the same
  // reason: stale prevention without a separate dedicated state slot.
  const [cachedFavUser, setCachedFavUser] = useState<{
    lookupName: string;
    id: number;
    name: string;
  } | null>(null);

  // After an import: load the user's media of the chosen type from
  // anilist.sqlite. Driven by an import-counter rather than directly
  // by the import callback so a re-import triggers a fresh load even
  // when type/username are unchanged.
  const [importTick, setImportTick] = useState(0);
  useEffect(() => {
    if (importTick === 0) return;
    let cancelled = false;
    void (async () => {
      const latest = await productionReads.getLatestAnilistUser();
      if (!latest) {
        if (!cancelled) {
          setCandidates([]);
          setCandidateSource(null);
        }
        return;
      }
      const rows = await productionReads.getListedMedia(latest.id, type);
      if (cancelled) return;
      const next = rows.map((m) =>
        mediaRowToItem(m, includeFormatInLabel),
      );
      setCandidates(next);
      setCandidateSource({
        kind: 'list',
        userId: latest.id,
        canonicalName: latest.name,
        type,
      });
      setSelectedIds(new Set(next.map((it) => it.id)));
      // Fresh import wipes the previous preview — clear search too
      // so the new preview opens with everything visible. Otherwise
      // a stale "Cowboy" search from an anime import would silently
      // hide every manga that doesn't contain "Cowboy".
      setSearch('');
    })();
    return () => {
      cancelled = true;
    };
  }, [importTick, type]);

  // Re-label loaded anime/manga candidates when the format toggle flips.
  useEffect(() => {
    if (candidates.length === 0 || !candidateSource) return;
    const isMediaList = candidateSource.kind === 'list';
    const isMediaFavs =
      candidateSource.kind === 'favourites' &&
      isMediaFavouriteType(candidateSource.type);
    if (!isMediaList && !isMediaFavs) return;

    let cancelled = false;
    void (async () => {
      let next: Item[];
      if (candidateSource.kind === 'list') {
        const rows = await productionReads.getListedMedia(
          candidateSource.userId,
          candidateSource.type,
        );
        next = rows.map((m) => mediaRowToItem(m, includeFormatInLabel));
      } else {
        const favs = await productionReads.getFavouritesAsItems(
          candidateSource.userId,
          candidateSource.type,
        );
        next = favs.map((fa) =>
          favouriteAsItemToItem(fa, candidateSource.type, includeFormatInLabel),
        );
      }
      if (cancelled) return;
      setCandidates(next);
      setSelectedIds((prev) => {
        const kept = new Set<ItemId>();
        for (const it of next) {
          if (prev.has(it.id)) kept.add(it.id);
        }
        return kept;
      });
    })();
    return () => {
      cancelled = true;
    };
    // Only re-fetch when the toggle changes — import/favourites paths
    // already map with the current includeFormatInLabel value.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- candidateSource/candidates intentionally omitted
  }, [includeFormatInLabel]);

  useEffect(() => {
    setCandidates((prev) =>
      prev.map((item) => relabelAnilistItem(item, includeFormatInLabel)),
    );
  }, [displayPrefs.mediaTitleMode, displayPrefs.personNameMode, displayPrefs.characterNameMode, includeFormatInLabel]);

  // Load per-favourite-type last-refresh timestamps + cached counts
  // for the user the typed `username` resolves to. Mirrors the
  // precedence used by `onUseCachedFavourites` (typed user → latest
  // imported fallback when the input is empty) so the displayed counts
  // always match what the "Use cached favourites" affordance loads.
  //
  // Runs on:
  //   - mount: initial load using latest-imported user (so the start
  //     screen opens with a useful hint, no input needed)
  //   - `username` change: debounced 300ms (mirrors `cachedListInfo`'s
  //     keystroke-friendly behaviour), with a synchronous clear of
  //     stale counts so the previous user's "12 cached characters"
  //     doesn't linger while bob's lookup is in flight
  //   - `favTick` bump: after a favourites refresh, immediate reload
  //   - `importTick` bump: after a media import, immediate reload
  //
  // The synchronous-clear is gated by a ref that tracks which
  // (trimmed) username we last loaded for. Without it, a `favTick`
  // bump while the user is still typing would also blank the cache
  // for 300ms even though the active query is unchanged.
  const lastFavLookupRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const trimmed = username.trim();
    const lookupChanged =
      lastFavLookupRef.current !== undefined &&
      lastFavLookupRef.current !== trimmed;
    lastFavLookupRef.current = trimmed;

    if (lookupChanged) {
      setFavouriteRefreshTs({
        CHARACTERS: null,
        STAFF: null,
        STUDIOS: null,
        ANIME: null,
        MANGA: null,
      });
      setFavouriteCounts({
        CHARACTERS: 0,
        STAFF: 0,
        STUDIOS: 0,
        ANIME: 0,
        MANGA: 0,
      });
      // Cached-favourites hint shares the same staleness window —
      // clear it now so the previous user's "Use cached favourites"
      // button can't load alice's data while the screen says bob.
      setCachedFavUser(null);
    }

    let cancelled = false;
    const load = async (): Promise<void> => {
      const user = trimmed
        ? (await productionReads.getAnilistUserByName(trimmed)) ??
          (await productionReads.getLatestAnilistUser())
        : await productionReads.getLatestAnilistUser();
      if (cancelled) return;
      if (!user) {
        // No imported users at all — keep the cleared/initial state.
        setCachedFavUser(null);
        return;
      }
      // Stamp the lookup name alongside the resolved user so the
      // cached-favourites hint stays in sync with what the user
      // currently has typed — without this, switching from alice
      // → bob would show bob's hint immediately even though we're
      // still rendering alice's counts until the effect re-runs.
      setCachedFavUser({ lookupName: trimmed, id: user.id, name: user.name });
      const [tsResults, countResults] = await Promise.all([
        Promise.all(
          FAVOURITE_TYPES.map((t) =>
            productionReads.getLastFavouritesRefresh(user.id, t),
          ),
        ),
        Promise.all(
          FAVOURITE_TYPES.map(async (t) => {
            const items = await productionReads.getFavouritesAsItems(user.id, t);
            return items.length;
          }),
        ),
      ]);
      if (cancelled) return;
      const nextTs: Record<AnilistFavouriteType, number | null> = {
        CHARACTERS: null,
        STAFF: null,
        STUDIOS: null,
        ANIME: null,
        MANGA: null,
      };
      const nextCounts: Record<AnilistFavouriteType, number> = {
        CHARACTERS: 0,
        STAFF: 0,
        STUDIOS: 0,
        ANIME: 0,
        MANGA: 0,
      };
      for (let i = 0; i < FAVOURITE_TYPES.length; i++) {
        nextTs[FAVOURITE_TYPES[i]] = tsResults[i];
        nextCounts[FAVOURITE_TYPES[i]] = countResults[i];
      }
      setFavouriteRefreshTs(nextTs);
      setFavouriteCounts(nextCounts);
    };

    // Debounce only when the user is actively typing — favTick /
    // importTick bumps come from explicit actions (refresh succeeded,
    // import succeeded) and the caller expects the new values to
    // appear without a 300ms delay.
    if (lookupChanged) {
      const timer = setTimeout(() => {
        void load();
      }, 300);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    void load();
    return () => {
      cancelled = true;
    };
    // dbSyncRevision: a Drive pull replaces the entire source DB but
    // doesn't bump favTick/importTick. Including it here re-runs the
    // favourite-timestamps + counts lookup so the UI catches up with
    // freshly pulled rows.
  }, [username, favTick, importTick, dbSyncRevision]);

  // Cache-aware lookup for the (username, type) pair. Debounced ~300ms
  // so a user typing their handle doesn't trigger a SQL round-trip
  // per keystroke. Sets `cachedListInfo` whenever the typed username
  // matches a previously-imported user AND that user has cached list
  // entries of the chosen type — drives the "Cached: N items
  // refreshed X ago — [Use cached]" hint + flips the primary CTA
  // label from "Import" to "Reimport".
  //
  // `importTick` is in the dep list so a successful import (or
  // explicit "Use cached" load) re-runs the lookup and the hint
  // updates without the user needing to re-type the name.
  useEffect(() => {
    const trimmed = username.trim();
    // Synchronously invalidate a stale hint BEFORE the 300ms debounce
    // schedules the next DB lookup. Without this, typing a new name
    // leaves the previous user's "Cached: N anime for alice" hint on
    // screen for ~300ms (and the "Reimport"/"Use cached" CTAs still
    // act on the previous lookup). The lookupName/lookupType stamps
    // on cachedListInfo are what let us tell "result is still
    // current" from "result is for a different query". An
    // importTick-only re-run (same name + type) preserves the hint
    // so the count updates in place after a successful import,
    // rather than blinking out and back in.
    setCachedListInfo((prev) => {
      if (!prev) return prev;
      if (prev.lookupName === trimmed && prev.lookupType === type) return prev;
      return null;
    });
    if (!trimmed) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const user = await productionReads.getAnilistUserByName(trimmed);
        if (cancelled) return;
        if (!user) {
          setCachedListInfo(null);
          return;
        }
        const [count, refreshedAt] = await Promise.all([
          productionReads.getListedMediaCount(user.id, type),
          productionReads.getLastFullRefresh(user.id, type),
        ]);
        if (cancelled) return;
        if (count === 0) {
          // No cached entries of THIS type — the user might have
          // cached MANGA but typed in a username they only imported
          // for ANIME, for example. Hide the hint rather than
          // showing a "0 items" promise that won't deliver anything
          // when "Use cached" is clicked.
          setCachedListInfo(null);
          return;
        }
        setCachedListInfo({
          lookupName: trimmed,
          lookupType: type,
          userId: user.id,
          canonicalName: user.name,
          count,
          refreshedAt,
        });
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // dbSyncRevision: same reasoning as the favourites effect above —
    // a pull from Drive needs to re-run this lookup so the
    // "Cached: N items refreshed X ago" hint reflects the new data.
  }, [username, type, importTick, dbSyncRevision]);

  // The candidate set IS the items array (post the state refactor:
  // both list-imported media + favourites materialise straight into
  // Item[] before being stored in `candidates`). Aliased for backward
  // compat with the rest of this component which still talks in
  // terms of `items` — keeps the FilterBar / preview / selection
  // code below untouched by the source-agnostic change.
  const items = candidates;

  // `visibleItems` reflects BOTH the FilterBar chip set AND the local
  // search box — they compose: the search narrows what the chips
  // already passed through. Empty search is a no-op (toLowerCase a
  // trimmed empty string short-circuits trivially), so users who
  // never touch the search bar see exactly the chip-filtered set.
  const visibleItems = useMemo<Item[]>(() => {
    const needle = search.trim().toLowerCase();
    const chipPassed = visibleIds === null
      ? items
      : items.filter((it) => visibleIds.has(it.id));
    if (needle === '') return chipPassed;
    return chipPassed.filter((it) => itemMatchesSearch(it, needle));
  }, [items, visibleIds, search]);

  const selectedCount = useMemo(() => {
    let n = 0;
    for (const it of visibleItems) {
      if (selectedIds.has(it.id)) n += 1;
    }
    return n;
  }, [visibleItems, selectedIds]);

  const toggleId = useCallback((id: ItemId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const it of visibleItems) next.add(it.id);
      return next;
    });
  }, [visibleItems]);

  const clearVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const it of visibleItems) next.delete(it.id);
      return next;
    });
  }, [visibleItems]);

  /**
   * Persist `name` as the "most recently used" prefill. Called from
   * `onRunImport` / `onRefreshFavourites` / `onUseCachedList` /
   * `onUseCachedFavourites` so a typo never overwrites the last good
   * value — only successful actions (or explicit cache-load clicks
   * that necessarily target an existing user) write here. The cache
   * paths persist the canonical AniList name when available so the
   * prefill normalises case across sessions ("alice" → "Alice").
   */
  const rememberUsername = useCallback((name: string) => {
    writeLastAnilistUsername(name);
  }, []);

  const onRunImport = useCallback(async () => {
    const name = username.trim();
    if (!name || importing) return;
    onDraftActivity();
    setError(null);
    setNotice(null);
    setProgress(null);
    setImporting(true);
    try {
      const result = await runAnilistImport(name, type, (e) => setProgress(e));
      rememberUsername(name);
      // Empty-list outcome: the import succeeded, the cache was
      // wiped/refreshed and the timestamp stamped — but there's
      // nothing for the FilterBar/preview to render. Surface a
      // confirmation so the user doesn't think the click did nothing.
      // We still bump importTick so the post-import effect clears any
      // stale media from a previous (non-empty) import of a different
      // user/type.
      if (result.entriesWritten === 0) {
        const typeLabel = type === 'ANIME' ? 'anime' : 'manga';
        setNotice(
          `${name}'s AniList ${typeLabel} list has no entries. The local cache was refreshed.`,
        );
      }
      setImportTick((t) => t + 1);
    } catch (err) {
      if (err instanceof AnilistUnknownUserError) {
        setError(`AniList username "${err.username}" not found.`);
      } else if (err instanceof AnilistScrapeLockHeldError) {
        setError('An import is already running — wait for it to finish.');
      } else {
        setError(err instanceof Error ? err.message : 'Import failed.');
      }
    } finally {
      setImporting(false);
      setProgress(null);
    }
  }, [username, type, importing, onDraftActivity, rememberUsername]);

  /**
   * Load the cached favourites of `favTypeArg` for `name` (must be
   * a previously-imported user) into the candidate preview, replacing
   * whatever was there. Shared between:
   *   - `onRefreshFavourites` (after a successful refresh — auto-load
   *     so the user immediately sees what to pick from)
   *   - `onUseCachedFavourites` (skip the API round-trip, load from
   *     cache for the same UX as `onUseCachedList`)
   *
   * Returns the loaded item count so callers can suppress the
   * "Use cached" hint refresh when there's nothing to show.
   */
  const loadFavouritesIntoCandidates = useCallback(
    async (name: string, favTypeArg: AnilistFavouriteType): Promise<number> => {
      const user = await productionReads.getAnilistUserByName(name);
      if (!user) {
        setCandidates([]);
        setCandidateSource(null);
        return 0;
      }
      const favs = await productionReads.getFavouritesAsItems(user.id, favTypeArg);
      const next = favs.map((fa) =>
        favouriteAsItemToItem(fa, favTypeArg, includeFormatInLabel),
      );
      setCandidates(next);
      setCandidateSource({
        kind: 'favourites',
        userId: user.id,
        canonicalName: user.name,
        type: favTypeArg,
      });
      setSelectedIds(new Set(next.map((it) => it.id)));
      setSearch('');
      return next.length;
    },
    [includeFormatInLabel],
  );

  const onRefreshFavourites = useCallback(async () => {
    const name = username.trim();
    if (!name || refreshingFavs || importing) return;
    onDraftActivity();
    setError(null);
    setNotice(null);
    setProgress(null);
    setRefreshingFavs(true);
    try {
      const result = await runAnilistFavourites(name, favType, (e) =>
        setProgress(e),
      );
      rememberUsername(name);
      // Empty-favourites outcome — same intent as the empty-list
      // notice in onRunImport: the user just clicked refresh and
      // their <type> favourites really are empty on AniList. Without
      // this surface they'd see no change anywhere (favourites don't
      // produce items, only enrich the detail modal + filter chip)
      // and wonder if the request even ran.
      if (result.favouritesWritten === 0) {
        setNotice(
          `${name} has no ${favouriteLabel(favType).toLowerCase()} favourites on AniList. The local cache was refreshed.`,
        );
      }
      setFavTick((t) => t + 1);
      // Auto-populate the candidate preview with the just-refreshed
      // favourites. Mirrors how `importTick` triggers a media reload
      // — a successful refresh implicitly means "show me these so I
      // can pick which to stage" instead of forcing the user to also
      // click "Use cached favourites" to see them.
      await loadFavouritesIntoCandidates(name, favType);
    } catch (err) {
      if (err instanceof AnilistUnknownUserError) {
        setError(`AniList username "${err.username}" not found.`);
      } else if (err instanceof AnilistScrapeLockHeldError) {
        setError('An import is already running — wait for it to finish.');
      } else {
        setError(err instanceof Error ? err.message : 'Favourites refresh failed.');
      }
    } finally {
      setRefreshingFavs(false);
      setProgress(null);
    }
  }, [
    username,
    favType,
    refreshingFavs,
    importing,
    onDraftActivity,
    rememberUsername,
    loadFavouritesIntoCandidates,
  ]);

  /**
   * Load `cachedListInfo`'s media rows from the local DB straight
   * into the preview, bypassing the API + scrape lock. Used by the
   * "Use cached list" affordance shown alongside the import CTA when
   * the typed username already has cached entries of the chosen type.
   *
   * Doesn't bump `importTick` because that path goes through
   * `getLatestAnilistUser` — and "Use cached" might be loading an
   * older user's data, not the latest. We just stage the rows
   * directly + reset selection/search to match the post-import UX.
   */
  const onUseCachedList = useCallback(async () => {
    if (!cachedListInfo || importing) return;
    onDraftActivity();
    setError(null);
    setNotice(null);
    // Persist the canonical AniList name as the last-used prefill —
    // explicit cache-load click confirms "this is the user I want",
    // and the canonical capitalization is more useful next session
    // than whatever the user happened to type. Matches the import
    // path's intent of "only write on successful, meaningful actions".
    rememberUsername(cachedListInfo.canonicalName);
    const rows = await productionReads.getListedMedia(
      cachedListInfo.userId,
      type,
    );
    const next = rows.map((m) => mediaRowToItem(m, includeFormatInLabel));
    setCandidates(next);
    setCandidateSource({
      kind: 'list',
      userId: cachedListInfo.userId,
      canonicalName: cachedListInfo.canonicalName,
      type,
    });
    setSelectedIds(new Set(next.map((it) => it.id)));
    setSearch('');
  }, [
    cachedListInfo,
    importing,
    type,
    includeFormatInLabel,
    onDraftActivity,
    rememberUsername,
  ]);

  /**
   * Skip-the-API counterpart to `onRefreshFavourites`. Pulls the
   * already-cached favourites of `favType` for the typed user (or
   * latest-imported fallback) straight into the candidate preview,
   * matching the "Use cached list" affordance on the media side.
   *
   * The user picks WHICH favourites to stage via the standard preview
   * checkboxes + "Add N selected to staged" CTA below — the bulk
   * "add everything" path that previously lived on this row is gone,
   * because the candidate-list flow handles that case (Select all
   * visible → Add to staged) AND supports filtering down to a subset.
   */
  const onUseCachedFavourites = useCallback(async () => {
    if (!cachedFavUser || importing || refreshingFavs) return;
    if (favouriteCounts[favType] === 0) return;
    onDraftActivity();
    setError(null);
    setNotice(null);
    // Use the typed-name fallback the favourites cache effect already
    // applied (latest-imported when input is empty). cachedFavUser
    // carries that resolved identity stamp, so the loaded items
    // always match what the "Cached: N" hint just promised.
    const name = cachedFavUser.name;
    // Persist the canonical name as the last-used prefill — same
    // rationale as onUseCachedList. Also covers the empty-typed-input
    // case: clicking the cached affordance with no typed name is
    // still an explicit "I want this user" signal worth remembering.
    rememberUsername(name);
    await loadFavouritesIntoCandidates(name, favType);
  }, [
    cachedFavUser,
    favouriteCounts,
    favType,
    importing,
    refreshingFavs,
    onDraftActivity,
    rememberUsername,
    loadFavouritesIntoCandidates,
  ]);

  const onAddSelectedToStaged = useCallback(() => {
    const out: Item[] = [];
    for (const it of items) {
      if (!visibleIds || visibleIds.has(it.id)) {
        if (selectedIds.has(it.id)) out.push(it);
      }
    }
    if (out.length === 0) return;
    // Source label reflects what the user actually loaded into the
    // candidate preview — list-imported media gets the original
    // `AniList: name/type` label; favourites get `AniList favourites:
    // name/<kind>` so a "favourite anime" group in the staged panel
    // is distinguishable from a "list anime" group from the same
    // user. Falls back to a generic label when nothing has been
    // loaded yet (shouldn't happen because the button is disabled
    // when items.length === 0, but the typeguard keeps it safe).
    let sourceLabel: string;
    if (candidateSource?.kind === 'list') {
      const typeLabel = candidateSource.type === 'ANIME' ? 'anime' : 'manga';
      sourceLabel = `AniList: ${candidateSource.canonicalName}/${typeLabel}`;
    } else if (candidateSource?.kind === 'favourites') {
      const kindLabel = favouriteLabel(candidateSource.type).toLowerCase();
      sourceLabel = `AniList favourites: ${candidateSource.canonicalName}/${kindLabel}`;
    } else {
      const name = username.trim() || 'unknown user';
      sourceLabel = `AniList: ${name}`;
    }
    onAddToStaged(out, sourceLabel);
    // Clear the selection so the user explicitly opts into the next
    // batch — protects against accidentally re-adding the same items
    // (which would dedup anyway, but is visually confusing).
    setSelectedIds(new Set());
  }, [
    items,
    visibleIds,
    selectedIds,
    onAddToStaged,
    candidateSource,
    username,
  ]);

  // Derived: cached-favourites hint info for the currently-selected
  // favType + typed user. Mirrors `cachedListInfo`'s shape so the
  // hint row JSX is structurally identical. Shows iff:
  //   - the favourites cache effect resolved a user (cachedFavUser)
  //   - that resolution matches the typed input (or input is empty
  //     and we're on the latest-imported fallback — same precedence
  //     as the favouriteCounts/refreshTs the row already displays)
  //   - the cache actually has entries of `favType` (zero would
  //     promise nothing and the "Use cached favourites" click would
  //     no-op)
  const trimmedUsername = username.trim();
  const cachedFavInfo: {
    userId: number;
    canonicalName: string;
    count: number;
    refreshedAt: number | null;
  } | null = (() => {
    if (!cachedFavUser) return null;
    if (trimmedUsername !== '' && cachedFavUser.lookupName !== trimmedUsername) {
      return null;
    }
    if (favouriteCounts[favType] === 0) return null;
    return {
      userId: cachedFavUser.id,
      canonicalName: cachedFavUser.name,
      count: favouriteCounts[favType],
      refreshedAt: favouriteRefreshTs[favType],
    };
  })();

  return (
    <div className="page-section anilist-start">
      <h2>Import from AniList</h2>
      <p className="csv-hint">
        Pull a user's anime or manga list, filter by genre / year /
        studio / tag / score, then sort. Imports refresh the local
        cache and (when cloud is connected) auto-push to your Drive
        folder.
      </p>

      <div className="anilist-start-bar">
        <input
          className="anilist-start-input"
          type="text"
          value={username}
          placeholder="AniList username"
          onChange={(e) => {
            setUsername(e.target.value);
            if (e.target.value.trim()) onDraftActivity();
          }}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => {
            // Enter still commits the Import action so muscle memory
            // works the same as when this was wrapped in a <form>
            // submit. Guard against the disabled-state combinations
            // for the same reasons the button is disabled.
            if (e.key !== 'Enter') return;
            if (importing || refreshingFavs || username.trim() === '') return;
            e.preventDefault();
            void onRunImport();
          }}
        />
        <label>
          <input
            type="radio"
            name="anilist-start-type"
            checked={type === 'ANIME'}
            onChange={() => setType('ANIME')}
          />{' '}
          Anime
        </label>
        <label>
          <input
            type="radio"
            name="anilist-start-type"
            checked={type === 'MANGA'}
            onChange={() => setType('MANGA')}
          />{' '}
          Manga
        </label>
        <button
          type="button"
          className="btn primary"
          disabled={importing || refreshingFavs || username.trim() === ''}
          onClick={() => void onRunImport()}
          title={
            cachedListInfo
              ? `Hit AniList again and overwrite the local cache for ${cachedListInfo.canonicalName}/${type.toLowerCase()}`
              : undefined
          }
        >
          {importing
            ? 'Importing…'
            : `${cachedListInfo ? 'Reimport' : 'Import'} ${type === 'ANIME' ? 'anime' : 'manga'}`}
        </button>
      </div>

      <div className="anilist-start-bar" style={{ marginTop: 4 }}>
        <label
          style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}
          title="Use romaji title plus AniList format, e.g. Shinryaku! Ika Musume (TV)"
        >
          <input
            type="checkbox"
            checked={includeFormatInLabel}
            onChange={(e) => {
              const next = e.target.checked;
              setIncludeFormatInLabel(next);
              try {
                localStorage.setItem(
                  ANILIST_FORMAT_IN_LABEL_LS_KEY,
                  next ? '1' : '0',
                );
              } catch {
                /* ignore */
              }
            }}
          />{' '}
          Append format to title (e.g. Title (TV))
        </label>
      </div>

      {/*
        Cache-aware hint row: shown ONLY when the typed username
        already has cached entries of the chosen type. The "Use
        cached list" button loads the previously-imported items
        straight into the preview without an API round-trip — much
        faster than a full re-scrape and what users almost always
        want when they're tweaking the chip filters or
        adding-to-staged in batches. Reimport stays available for
        when the user actually wants fresh data.
      */}
      {cachedListInfo && !importing && (
        <div
          className="anilist-start-bar anilist-cache-hint"
          style={{ marginTop: 4 }}
          role="status"
          aria-live="polite"
        >
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            Cached: <strong>{cachedListInfo.count}</strong>{' '}
            {type === 'ANIME' ? 'anime' : 'manga'} for{' '}
            <strong>{cachedListInfo.canonicalName}</strong>
            {cachedListInfo.refreshedAt !== null && (
              <> · imported {timeAgo(cachedListInfo.refreshedAt)}</>
            )}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => void onUseCachedList()}
            disabled={importing || refreshingFavs}
            title="Load the previously-imported items from the local cache without hitting AniList"
          >
            Use cached list
          </button>
        </div>
      )}

      <div
        className="anilist-start-bar"
        style={{ marginTop: 4 }}
      >
        <span
          style={{ color: 'var(--text-muted)', fontSize: 12 }}
          title="Refreshing populates the favourites filter chip and the detail modal's character/staff/studio rows, and loads the favourites into the candidate preview so you can pick which to sort (Select all visible + Add N selected to staged)."
        >
          Favourites cache:
        </span>
        <select
          className="anilist-start-input"
          style={{ flex: '0 0 auto' }}
          value={favType}
          onChange={(e) => setFavType(e.target.value as AnilistFavouriteType)}
          aria-label="Favourites connection to refresh"
          disabled={refreshingFavs || importing}
        >
          {FAVOURITE_TYPES.map((t) => (
            <option key={t} value={t}>
              {favouriteLabel(t)}
              {favouriteCounts[t] > 0 ? ` (${favouriteCounts[t]})` : ''}
            </option>
          ))}
        </select>
        {/*
          Refresh button is the favourites-bar equivalent of the
          "Import" button on the media bar. After a successful
          refresh, the favourites auto-populate the candidate preview
          (matching the post-import UX) so the user can immediately
          filter + select + stage without a second click.
        */}
        <button
          type="button"
          className="btn primary"
          disabled={refreshingFavs || importing || username.trim() === ''}
          onClick={() => void onRefreshFavourites()}
          title={
            cachedFavInfo
              ? `Hit AniList again and overwrite the local cache for ${cachedFavInfo.canonicalName}/${favouriteLabel(favType).toLowerCase()} favourites`
              : `Refresh ${favouriteLabel(favType).toLowerCase()} favourites cache from AniList`
          }
        >
          {refreshingFavs
            ? 'Refreshing…'
            : `Refresh ${favouriteLabel(favType).toLowerCase()}`}
        </button>
      </div>

      {/*
        Cache-aware hint row for favourites — structurally identical
        to the cached-list hint above. Shown ONLY when the typed
        username already has cached favourites of the selected
        favType. The "Use cached favourites" button loads them into
        the candidate preview without an API round-trip — same
        Select/Filter/Add flow as a list import, just sourced from
        the favourites cache.
      */}
      {cachedFavInfo && !refreshingFavs && !importing && (
        <div
          className="anilist-start-bar anilist-cache-hint"
          style={{ marginTop: 4 }}
          role="status"
          aria-live="polite"
        >
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            Cached: <strong>{cachedFavInfo.count}</strong>{' '}
            {favouriteLabel(favType).toLowerCase()} favourites for{' '}
            <strong>{cachedFavInfo.canonicalName}</strong>
            {cachedFavInfo.refreshedAt !== null && (
              <> · refreshed {timeAgo(cachedFavInfo.refreshedAt)}</>
            )}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => void onUseCachedFavourites()}
            disabled={importing || refreshingFavs}
            title="Load the previously-refreshed favourites from the local cache without hitting AniList"
          >
            Use cached favourites
          </button>
        </div>
      )}

      {(importing || refreshingFavs) && (
        <p
          className="anilist-progress"
          aria-live="polite"
          style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 13 }}
        >
          {progress ? formatAnilistProgress(progress) : 'Connecting to AniList…'}
        </p>
      )}

      {error && (
        <p style={{ marginTop: 8, color: 'var(--warning)', fontSize: 13 }}>
          {error}
        </p>
      )}

      {notice && !error && (
        <p
          // role=status + aria-live=polite so screen readers announce
          // the empty-import confirmation without interrupting; matches
          // how a brief toast would behave but stays in-flow so the
          // user can also see it visually after the spinner clears.
          role="status"
          aria-live="polite"
          style={{
            marginTop: 8,
            color: 'var(--accent)',
            fontSize: 13,
          }}
        >
          {notice}
        </p>
      )}

      {items.length > 0 && (
        <>
          <FilterBar items={items} onVisibleChange={setVisibleIds} />

          <div className="anilist-start-bar anilist-preview-actions" style={{ marginTop: 4 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {visibleItems.length} of {items.length} shown · {selectedCount} selected
            </span>
            <button className="btn" onClick={selectAllVisible}>
              Select all visible
            </button>
            <button className="btn" onClick={clearVisible}>
              Clear visible
            </button>
            {/*
              Search box pushed to the right edge by `marginLeft: auto`
              — visually pairs with "Clear visible" so the user reads
              "narrow the preview" + "act on what's narrowed" as one
              cluster. type="search" gives Webkit/Blink a built-in
              clear (×) affordance for free without us shipping a
              clear button. Live-narrows via the visibleItems memo.
            */}
            <input
              type="search"
              className="anilist-start-input anilist-preview-search"
              style={{ marginLeft: 'auto' }}
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search preview by title"
              spellCheck={false}
            />
          </div>

          <div className="anilist-start-preview">
            {visibleItems.map((it) => {
              const checked = selectedIds.has(it.id);
              return (
                <label className="anilist-start-preview-row" key={it.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleId(it.id)}
                  />
                  <ItemThumb
                    item={it}
                    className="anilist-start-preview-cover"
                    placeholderClass=""
                  />
                  <span className="anilist-start-preview-label">
                    {it.label}
                  </span>
                </label>
              );
            })}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button
              className="btn primary"
              disabled={selectedCount < 1}
              onClick={onAddSelectedToStaged}
              title="Append these to the staged items panel below — combine with clipboard, pre-ranked lists, or other AniList batches before sorting"
            >
              Add {selectedCount} selected to staged
            </button>
          </div>
        </>
      )}
    </div>
  );
}
