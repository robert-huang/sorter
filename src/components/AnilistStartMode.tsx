import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilterBar } from './FilterBar';
import type { Item, ItemId } from '../lib/types';
import {
  AnilistScrapeLockHeldError,
  AnilistUnknownUserError,
} from '../lib/importers/anilist/importer';
import { productionReads } from '../lib/importers/anilist/readQueries';
import { runAnilistImport } from '../lib/importers/anilist/runners';
import type {
  AnilistMediaType,
  MediaRow,
} from '../lib/importers/anilist/types';

/**
 * StartScreen "anilist" tab content. Owns the full import-and-pick
 * flow:
 *
 *   1. Username + ANIME/MANGA radio + Refresh.
 *   2. While importing: per-page progress hint.
 *   3. On success: pull every imported media row out of anilist.sqlite,
 *      hand them to the cross-source FilterBar, render a preview list
 *      with per-row checkboxes (default all-checked).
 *   4. "Sort N selected items" CTA → calls onStartScratch with each
 *      selected media materialised as an Item carrying
 *      `source: { kind: 'anilist', externalId: media.id }`.
 *
 * Username is captured per-action and not persisted as a setting,
 * matching the Phase D locked decision. localStorage holds the
 * "last typed" value as a default-fill convenience — written only on
 * a successful import so a typo never overwrites the last good value.
 */

const ANILIST_USERNAME_LS_KEY = 'anilist:lastUsername';

interface Props {
  /** Called when the user confirms a selection. Items carry
   *  `source: { kind: 'anilist', externalId }` so the LIST tab can
   *  open the detail modal + the FilterBar can render chips. */
  onStartScratch: (items: Item[]) => void;
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

export function AnilistStartMode({ onStartScratch, onDraftActivity }: Props) {
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
  const [media, setMedia] = useState<MediaRow[]>([]);
  // Per-row selection. Drives the "Sort N selected items" CTA's count
  // and the final items[] handed to onStartScratch. Defaults to "all
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
    setImporting(true);
    try {
      await runAnilistImport(name, type);
      try {
        localStorage.setItem(ANILIST_USERNAME_LS_KEY, name);
      } catch {
        /* ignore */
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
    }
  }, [username, type, importing, onDraftActivity]);

  const onStartSelected = useCallback(() => {
    const out: Item[] = [];
    for (const it of items) {
      if (!visibleIds || visibleIds.has(it.id)) {
        if (selectedIds.has(it.id)) out.push(it);
      }
    }
    if (out.length === 0) return;
    onStartScratch(out);
  }, [items, visibleIds, selectedIds, onStartScratch]);

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
          className="btn primary"
          disabled={importing || username.trim() === ''}
          onClick={() => void onRunImport()}
        >
          {importing ? 'Importing…' : `Import ${type === 'ANIME' ? 'anime' : 'manga'}`}
        </button>
      </div>

      {error && (
        <p style={{ marginTop: 8, color: 'var(--warning)', fontSize: 13 }}>
          {error}
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
              onClick={onStartSelected}
            >
              {selectedCount < 2
                ? `Use as ranking (${selectedCount})`
                : `Sort ${selectedCount} selected item${selectedCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
