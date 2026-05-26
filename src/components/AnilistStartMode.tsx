import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilterBar } from './FilterBar';
import type { Item, ItemId } from '../lib/types';
import {
  AnilistScrapeLockHeldError,
  AnilistUnknownUserError,
} from '../lib/importers/anilist/importer';
import type { AnilistProgressEvent } from '../lib/importers/anilist/progress';
import { productionReads } from '../lib/importers/anilist/readQueries';
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
    })();
    return () => {
      cancelled = true;
    };
  }, [importTick, type]);

  // Load per-favourite-type last-refresh timestamps. Runs on mount
  // (so the "refreshed Xm ago" hint shows correctly the first time
  // the start screen opens) and after every successful refresh
  // (bumping favTick). Skipped when no user has been imported yet —
  // there's nothing to show timestamps against.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const latest = await productionReads.getLatestAnilistUser();
      if (!latest || cancelled) return;
      const results = await Promise.all(
        FAVOURITE_TYPES.map((t) =>
          productionReads.getLastFavouritesRefresh(latest.id, t),
        ),
      );
      if (cancelled) return;
      const next: Record<AnilistFavouriteType, number | null> = {
        CHARACTERS: null,
        STAFF: null,
        STUDIOS: null,
        ANIME: null,
        MANGA: null,
      };
      for (let i = 0; i < FAVOURITE_TYPES.length; i++) {
        next[FAVOURITE_TYPES[i]] = results[i];
      }
      setFavouriteRefreshTs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [favTick, importTick]);

  // Convert media rows to Items once — both the FilterBar and the
  // preview list iterate this. Memoed so a re-render from chip-state
  // changes doesn't re-walk the rows.
  const items = useMemo<Item[]>(() => media.map(mediaRowToItem), [media]);

  const visibleItems = useMemo<Item[]>(() => {
    if (visibleIds === null) return items;
    return items.filter((it) => visibleIds.has(it.id));
  }, [items, visibleIds]);

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
      try {
        localStorage.setItem(ANILIST_USERNAME_LS_KEY, name);
      } catch {
        /* ignore */
      }
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
  }, [username, type, importing, onDraftActivity]);

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
      try {
        localStorage.setItem(ANILIST_USERNAME_LS_KEY, name);
      } catch {
        /* ignore */
      }
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
  }, [username, favType, refreshingFavs, importing]);

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
        Real <form> so the browser registers an Import click (or Enter
        in the username field) as a value-commit and persists the typed
        username in its autofill history. The user sees the usual
        suggestion dropdown on focus and can Shift+Delete (or
        Fn+Shift+Delete on macOS) to remove individual entries. Three
        things need to line up for browsers to record + offer:
          1. A stable `name` on the input (history is keyed on
             name + origin).
          2. autoComplete that is NOT "off". `nickname` semantically
             fits an AniList handle, and unlike `username` it does not
             entangle the field with password-manager flows (so you do
             not get a "save password?" prompt on import).
          3. An honest form submit — click on a submit-typed button or
             Enter inside the text field. preventDefault keeps the page
             from navigating; onRunImport is the same path the old
             click handler took.
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
          autoComplete="nickname"
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
          type="submit"
          className="btn primary"
          disabled={importing || refreshingFavs || username.trim() === ''}
        >
          {importing ? 'Importing…' : `Import ${type === 'ANIME' ? 'anime' : 'manga'}`}
        </button>
      </form>

      <div
        className="anilist-start-bar"
        style={{ marginTop: 4 }}
        title="Favourites populate the favourites filter chip and the detail modal's character/staff/studio rows. Refreshing them doesn't seed items to sort — for that, use Import above."
      >
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
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
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn icon-only"
          disabled={refreshingFavs || importing || username.trim() === ''}
          onClick={() => void onRefreshFavourites()}
          title={`Refresh ${favouriteLabel(favType).toLowerCase()} favourites cache (refreshed ${timeAgo(
            favouriteRefreshTs[favType],
          )})`}
          aria-label={`Refresh ${favouriteLabel(favType)} favourites cache`}
        >
          ↻
        </button>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          refreshed {timeAgo(favouriteRefreshTs[favType])}
        </span>
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

          <div className="anilist-start-bar" style={{ marginTop: 4 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {visibleItems.length} of {items.length} shown · {selectedCount} selected
            </span>
            <button className="btn" onClick={selectAllVisible}>
              Select all visible
            </button>
            <button className="btn" onClick={clearVisible}>
              Clear visible
            </button>
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
