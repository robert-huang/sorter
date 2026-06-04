import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnilistImportContext } from '../lib/importers/anilist/context';
import { searchAnimeInCache } from '../lib/importers/anilist/graphQueries';
import {
  fetchAnimeById,
  pickRandomAnimeFromApi,
  searchAnimeFromApi,
} from '../lib/importers/anilist/setupMedia';
import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';

interface Props {
  label: string;
  media: MediaRow | null;
  importCtx: AnilistImportContext;
  disabled?: boolean;
  onSelect: (media: MediaRow) => void;
  onRandomFromCache: () => void;
  onError: (message: string | null) => void;
}

export function EndpointPicker({
  label,
  media,
  importCtx,
  disabled = false,
  onSelect,
  onRandomFromCache,
  onError,
}: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MediaRow[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [apiLoading, setApiLoading] = useState(false);
  const [anilistId, setAnilistId] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (trimmed.length === 0) {
        setSearchResults([]);
        return;
      }
      setSearchLoading(true);
      try {
        const cacheHits = await searchAnimeInCache(importCtx.db, trimmed, 15);
        let results = cacheHits;
        if (trimmed.length >= 2 && cacheHits.length < 5) {
          const apiHits = await searchAnimeFromApi(importCtx, trimmed, 10);
          const seen = new Set(results.map((r) => r.id));
          for (const row of apiHits) {
            if (!seen.has(row.id)) {
              seen.add(row.id);
              results = [...results, row];
            }
          }
        }
        setSearchResults(results);
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Search failed.');
      } finally {
        setSearchLoading(false);
      }
    },
    [importCtx, onError],
  );

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      void runSearch(searchQuery);
    }, 300);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [searchQuery, runSearch]);

  const onLoadById = async () => {
    const id = Number.parseInt(anilistId.trim(), 10);
    if (!Number.isFinite(id) || id <= 0) {
      onError('Enter a valid AniList media id.');
      return;
    }
    setApiLoading(true);
    onError(null);
    try {
      const row = await fetchAnimeById(importCtx, id);
      if (!row) {
        onError(`No anime found for id ${id}.`);
        return;
      }
      onSelect(row);
      setSearchQuery('');
      setSearchResults([]);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setApiLoading(false);
    }
  };

  const onRandomApi = async () => {
    setApiLoading(true);
    onError(null);
    try {
      const row = await pickRandomAnimeFromApi(importCtx);
      if (!row) {
        onError('Could not pick a random anime from AniList.');
        return;
      }
      onSelect(row);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Random pick failed.');
    } finally {
      setApiLoading(false);
    }
  };

  const busy = disabled || apiLoading;

  return (
    <section className="page-section anime-to-anime-endpoint-card">
      <h2 className="anime-to-anime-section-title">{label}</h2>
      {media?.cover_image && (
        <img src={media.cover_image} alt="" className="anime-to-anime-endpoint-cover" />
      )}
      <p className="anime-to-anime-endpoint-value">{media ? pickMediaTitle(media) : '—'}</p>

      <div className="anime-to-anime-actions">
        <button type="button" className="btn small" disabled={busy} onClick={onRandomFromCache}>
          Random from cache
        </button>
        <button type="button" className="btn small" disabled={busy} onClick={() => void onRandomApi()}>
          Random from AniList
        </button>
      </div>

      <div className="anime-to-anime-endpoint-search">
        <label className="anime-to-anime-endpoint-search-label">
          Search
          <input
            type="search"
            className="slot-search"
            placeholder="Title in cache or AniList…"
            value={searchQuery}
            disabled={busy}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        {searchLoading && <p className="settings-status">Searching…</p>}
        {searchResults.length > 0 && (
          <ul className="anime-to-anime-endpoint-results">
            {searchResults.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="btn link anime-to-anime-endpoint-result-btn"
                  disabled={busy}
                  onClick={() => {
                    onSelect(row);
                    setSearchQuery('');
                    setSearchResults([]);
                  }}
                >
                  {pickMediaTitle(row)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="anime-to-anime-endpoint-id">
        <label className="anime-to-anime-endpoint-search-label">
          AniList ID
          <input
            type="number"
            className="slot-search"
            min={1}
            value={anilistId}
            disabled={busy}
            onChange={(e) => setAnilistId(e.target.value)}
          />
        </label>
        <button type="button" className="btn small" disabled={busy} onClick={() => void onLoadById()}>
          Load
        </button>
      </div>
    </section>
  );
}
