import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilterBar } from './FilterBar';
import type { Item, ItemId } from '../lib/types';
import {
  buildAnilistFavouriteUrl,
  buildAnilistMediaUrl,
} from '../lib/importers/anilist/anilistSource';
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
import {
  addUsernameToHistory,
  clearUsernameHistory,
  loadUsernameHistory,
} from '../lib/usernameHistory';
import { formatAnilistProgress } from './anilistProgressLabel';

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

const ANILIST_USERNAME_LS_KEY = 'anilist:lastUsername';
/**
 * Storage key for the most-recently-used usernames list. Backs the
 * `<datalist>` dropdown wired to the username input — separate from
 * `ANILIST_USERNAME_LS_KEY` (which holds the single last-typed value
 * for default-fill) so that wiping the history doesn't also clobber
 * the default-fill prefill.
 */
const ANILIST_USERNAME_HISTORY_KEY = 'anilist:usernameHistory';

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
}

/** Best-available title from a media row, defaulting through romaji
 *  → english → native → "Untitled". Matches what most AniList UIs
 *  render as the canonical display title. */
function pickTitle(m: MediaRow): string {
  return (
    m.title_romaji ??
    m.title_english ??
    m.title_native ??
    `Untitled (${m.id})`
  );
}

/**
 * Materialise a MediaRow into an Item ready to seed the sorter. The
 * Item id is the AniList media id stringified — stable, collision-
 * proof across sources because of the source discriminator, and
 * compact in the autosave blob.
 */
function mediaRowToItem(m: MediaRow): Item {
  return {
    id: `anilist:${m.id}`,
    label: pickTitle(m),
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

export function AnilistStartMode({ onAddToStaged, onDraftActivity }: Props) {
  const [username, setUsername] = useState<string>(() => {
    try {
      return localStorage.getItem(ANILIST_USERNAME_LS_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [type, setType] = useState<AnilistMediaType>('ANIME');
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
  const [media, setMedia] = useState<MediaRow[]>([]);
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
  // visible). Computed downstream of `media`, so a fresh import
  // resets it implicitly via the FilterBar's own state.
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
  // localStorage-backed history for the username field. Drives the
  // `<datalist>` dropdown wired to the input so the user gets a
  // reliable suggestion list regardless of browser autofill quirks.
  // Initialised lazily from storage so a re-mount picks up additions
  // from a prior session immediately.
  const [usernameHistory, setUsernameHistory] = useState<string[]>(() =>
    loadUsernameHistory(ANILIST_USERNAME_HISTORY_KEY),
  );
  // Cache-aware hint for the typed (username, type) pair. Populated by
  // the debounced effect below. Null means "we haven't found a cached
  // list for this combo" — UI hides the "Use cached" button and shows
  // a plain "Import" CTA. Non-null lets the user skip the API round
  // trip and load the previously-imported items directly.
  const [cachedListInfo, setCachedListInfo] = useState<{
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
  const [loadingFavouritesAdd, setLoadingFavouritesAdd] = useState(false);

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
        if (!cancelled) setMedia([]);
        return;
      }
      const rows = await productionReads.getListedMedia(latest.id, type);
      if (cancelled) return;
      setMedia(rows);
      setSelectedIds(new Set(rows.map((r) => `anilist:${r.id}`)));
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

  // Load per-favourite-type last-refresh timestamps + cached counts.
  // Runs on mount (so the "refreshed Xm ago" hint + "+ Add N to
  // staged" button counts show correctly the first time the start
  // screen opens) and after every successful refresh/import. Both
  // queries are keyed on the LATEST imported user — that's the same
  // user the [↻] favourites button resolves against, so the
  // displayed counts and what gets added to staged stay in sync.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const latest = await productionReads.getLatestAnilistUser();
      if (!latest || cancelled) return;
      const [tsResults, countResults] = await Promise.all([
        Promise.all(
          FAVOURITE_TYPES.map((t) =>
            productionReads.getLastFavouritesRefresh(latest.id, t),
          ),
        ),
        Promise.all(
          FAVOURITE_TYPES.map(async (t) => {
            const items = await productionReads.getFavouritesAsItems(latest.id, t);
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
    })();
    return () => {
      cancelled = true;
    };
  }, [favTick, importTick]);

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
    if (!trimmed) {
      setCachedListInfo(null);
      return;
    }
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
  }, [username, type, importTick]);

  // Convert media rows to Items once — both the FilterBar and the
  // preview list iterate this. Memoed so a re-render from chip-state
  // changes doesn't re-walk the rows.
  const items = useMemo<Item[]>(() => media.map(mediaRowToItem), [media]);

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
    return chipPassed.filter((it) => it.label.toLowerCase().includes(needle));
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
   * Persist `name` as the "most recently used" prefill AND push it
   * onto the dropdown-history list. Both writes share the same
   * trigger (successful import / successful favourites refresh) so
   * a typo never enters either store. The history setter updates
   * local state too so the next render shows the addition in the
   * `<datalist>` without remounting.
   */
  const rememberUsername = useCallback((name: string) => {
    try {
      localStorage.setItem(ANILIST_USERNAME_LS_KEY, name);
    } catch {
      /* ignore */
    }
    const next = addUsernameToHistory(ANILIST_USERNAME_HISTORY_KEY, name);
    setUsernameHistory(next);
  }, []);

  const onClearUsernameHistory = useCallback(() => {
    clearUsernameHistory(ANILIST_USERNAME_HISTORY_KEY);
    setUsernameHistory([]);
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

  const onRefreshFavourites = useCallback(async () => {
    const name = username.trim();
    if (!name || refreshingFavs || importing) return;
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
  }, [username, favType, refreshingFavs, importing, rememberUsername]);

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
    const rows = await productionReads.getListedMedia(
      cachedListInfo.userId,
      type,
    );
    setMedia(rows);
    setSelectedIds(new Set(rows.map((r) => `anilist:${r.id}`)));
    setSearch('');
  }, [cachedListInfo, importing, type, onDraftActivity]);

  /**
   * Materialise the currently-selected favourites type as Items and
   * push them to the staged-items panel as a single flat group. Lets
   * the user sort "my favourite anime" / "my favourite characters"
   * etc. directly from the favourites cache without having to import
   * a full list first.
   *
   * Source binding only applies to ANIME/MANGA — those map cleanly
   * onto the existing AniList Item.source kind so the LIST tab's
   * filter chips + detail modal still attach. CHARACTERS/STAFF/
   * STUDIOS don't have a source kind in the type system (the AniList
   * chip module is media-only), so they ship as manual-source Items
   * with a `anilist-<kind>:<id>` id prefix that's unique vs media
   * ids — they sort just fine, they just don't get rich filter chips.
   */
  const onAddFavouritesToStaged = useCallback(async () => {
    if (loadingFavouritesAdd) return;
    const count = favouriteCounts[favType];
    if (count === 0) return;
    setLoadingFavouritesAdd(true);
    try {
      // Prefer the typed user when it matches a cached row, otherwise
      // fall back to the latest imported user — same precedence the
      // count display uses, so the button never adds different rows
      // than the count promises.
      const typed = username.trim();
      const user =
        (typed ? await productionReads.getAnilistUserByName(typed) : null) ??
        (await productionReads.getLatestAnilistUser());
      if (!user) return;
      const favs: FavouriteAsItem[] = await productionReads.getFavouritesAsItems(
        user.id,
        favType,
      );
      if (favs.length === 0) return;
      const items: Item[] = favs.map((fa) => {
        // Single URL builder for all 5 favourite kinds — keeps the
        // ANIME/MANGA path consistent with the list-import URL and
        // gives CHARACTERS/STAFF/STUDIOS a clickable anilist.co link
        // too (lets the user pop the entry open while sorting to
        // disambiguate by portrait / VA credits).
        const url = buildAnilistFavouriteUrl(favType, fa.externalId);
        if (favType === 'ANIME' || favType === 'MANGA') {
          // Same id scheme as the list-import path so deduping
          // across favourites + list ends up collapsing correctly
          // when the user pulls both into one sort.
          return {
            id: `anilist:${fa.externalId}`,
            label: fa.label,
            url,
            imageUrl: fa.imageUrl ?? undefined,
            source: { kind: 'anilist', externalId: fa.externalId },
          };
        }
        // Non-media favourites — prefix the id with the kind so a
        // character #100 and a staff #100 don't collide in the
        // dedup set if the user happens to favourite both.
        const kindSlug = favType.toLowerCase();
        return {
          id: `anilist-${kindSlug}:${fa.externalId}`,
          label: fa.label,
          url,
          imageUrl: fa.imageUrl ?? undefined,
        };
      });
      const sourceLabel = `AniList favourites: ${user.name}/${favouriteLabel(favType).toLowerCase()}`;
      onAddToStaged(items, sourceLabel);
    } finally {
      setLoadingFavouritesAdd(false);
    }
  }, [
    loadingFavouritesAdd,
    favouriteCounts,
    favType,
    username,
    onAddToStaged,
  ]);

  const onAddSelectedToStaged = useCallback(() => {
    const out: Item[] = [];
    for (const it of items) {
      if (!visibleIds || visibleIds.has(it.id)) {
        if (selectedIds.has(it.id)) out.push(it);
      }
    }
    if (out.length === 0) return;
    const name = username.trim() || 'unknown user';
    const typeLabel = type === 'ANIME' ? 'anime' : 'manga';
    const sourceLabel = `AniList: ${name}/${typeLabel}`;
    onAddToStaged(out, sourceLabel);
    // Clear the selection so the user explicitly opts into the next
    // batch — protects against accidentally re-adding the same items
    // (which would dedup anyway, but is visually confusing).
    setSelectedIds(new Set());
  }, [items, visibleIds, selectedIds, onAddToStaged, username, type]);

  return (
    <div className="page-section anilist-start">
      <h2>Import from AniList</h2>
      <p className="csv-hint">
        Pull a user's anime or manga list, filter by genre / year /
        studio / tag / score, then sort. Imports refresh the local
        cache and (when cloud is connected) auto-push to your Drive
        folder.
      </p>

      {/*
        Real <form> so the browser AT LEAST has a chance to register
        an Import click (or Enter in the username field) as a
        value-commit for its own autofill history. Three things need
        to line up for native autofill to record + offer:
          1. A stable `name` on the input.
          2. autoComplete that is NOT "off".
          3. An honest form submit — submit-typed button or Enter.
        Even with all three, Chrome's heuristics for recording
        non-password fields are notoriously inconsistent (controlled
        inputs, preventDefault submits, dev URLs all hit edge cases),
        so the input is ALSO wired to a `<datalist>` backed by our
        own localStorage history. That dropdown ALWAYS appears on
        focus and is updated by `rememberUsername` on every
        successful import or favourites refresh — users get a
        predictable suggestion list regardless of browser quirks.
      */}
      <form
        className="anilist-start-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (importing || refreshingFavs || username.trim() === '') return;
          void onRunImport();
        }}
      >
        <input
          className="anilist-start-input"
          type="text"
          name="anilist-username"
          value={username}
          placeholder="AniList username"
          onChange={(e) => {
            setUsername(e.target.value);
            if (e.target.value.trim()) onDraftActivity();
          }}
          spellCheck={false}
          autoComplete="username"
          list="anilist-username-history"
        />
        {/*
          Local-history dropdown. Populated from localStorage so
          previously-imported usernames suggest on focus even if
          Chrome's native autofill never recorded the form
          submission. <datalist> options can't be individually
          deleted from the popup (no Shift+Delete in this fallback
          path), so a separate "Clear history" link below the form
          handles bulk removal.
        */}
        <datalist id="anilist-username-history">
          {usernameHistory.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
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
          type="submit"
          className="btn primary"
          disabled={importing || refreshingFavs || username.trim() === ''}
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
      </form>

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

      {/*
        "Clear history" affordance for the local datalist. Only
        rendered when there's something to clear so a fresh install
        doesn't show a dangling link. Sits below the form so it
        doesn't compete visually with the Import CTA.
      */}
      {usernameHistory.length > 0 && (
        <div
          className="anilist-start-bar"
          style={{ marginTop: 2, gap: 6 }}
        >
          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
            {usernameHistory.length} recent username
            {usernameHistory.length === 1 ? '' : 's'} remembered locally.
          </span>
          <button
            type="button"
            className="btn small"
            onClick={onClearUsernameHistory}
            title="Forget every username suggested by the local dropdown (does not affect AniList itself)"
            style={{ fontSize: 11, padding: '2px 6px' }}
          >
            Clear history
          </button>
        </div>
      )}

      <div
        className="anilist-start-bar"
        style={{ marginTop: 4 }}
      >
        <span
          style={{ color: 'var(--text-muted)', fontSize: 12 }}
          title="Refreshing populates the favourites filter chip and the detail modal's character/staff/studio rows. Use the green button on the right to also stage them as items to sort."
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
        <button
          type="button"
          className="btn icon-only"
          disabled={refreshingFavs || importing || username.trim() === ''}
          onClick={() => void onRefreshFavourites()}
          title={`Refresh ${favouriteLabel(favType).toLowerCase()} favourites cache from AniList (last refreshed ${timeAgo(
            favouriteRefreshTs[favType],
          )})`}
          aria-label={`Refresh ${favouriteLabel(favType)} favourites cache`}
        >
          ↻
        </button>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {favouriteCounts[favType]} cached · refreshed{' '}
          {timeAgo(favouriteRefreshTs[favType])}
        </span>
        {/*
          The bread-and-butter "+ Add N to staged" action — gives the
          favourites cache a sortable outlet that previously didn't
          exist. Disabled when the cache is empty so the user gets a
          visible-but-inert button explaining the state rather than
          a silent missing affordance.
        */}
        <button
          type="button"
          className="btn primary"
          style={{ marginLeft: 'auto' }}
          disabled={
            loadingFavouritesAdd ||
            refreshingFavs ||
            importing ||
            favouriteCounts[favType] === 0
          }
          onClick={() => void onAddFavouritesToStaged()}
          title={
            favouriteCounts[favType] === 0
              ? `No ${favouriteLabel(favType).toLowerCase()} favourites in the local cache yet — click ↻ first to fetch them from AniList.`
              : `Add the cached ${favouriteCounts[favType]} ${favouriteLabel(favType).toLowerCase()} favourites to the staged-items panel so you can sort them.`
          }
        >
          + Add {favouriteCounts[favType] || ''}{' '}
          {favouriteLabel(favType).toLowerCase()} to staged
        </button>
      </div>

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
                  {it.imageUrl && (
                    <img
                      className="anilist-start-preview-cover"
                      src={it.imageUrl}
                      alt=""
                      loading="lazy"
                    />
                  )}
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
