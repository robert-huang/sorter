import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnilistImportContext } from '../lib/importers/anilist/context';
import { searchAnimeInCache } from '../lib/importers/anilist/graphQueries';
import { AnilistIcon } from '../lib/importers/anilist/icon';
import { DatabaseIcon, UserIcon } from '../components/icons';
import {
  AnilistScrapeLockHeldError,
  AnilistUnknownUserError,
} from '../lib/importers/anilist/importer';
import {
  fetchAnimeById,
  pickRandomAnimeFromApi,
  pickRandomAnimeFromUserList,
  searchAnimeFromApi,
} from '../lib/importers/anilist/setupMedia';
import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import {
  anilistUrlForMedia,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from './anilistMiddleClick';

/**
 * Shared with the START screen's AniList tab: the last-imported handle is
 * remembered here so the A2A "random from user list" field prefills with
 * whatever the user last imported, anywhere in the app.
 */
const ANILIST_USERNAME_LS_KEY = 'anilist:lastUsername';

function readLastUsername(): string {
  try {
    return localStorage.getItem(ANILIST_USERNAME_LS_KEY) ?? '';
  } catch {
    return '';
  }
}

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
  const [username, setUsername] = useState(readLastUsername);
  const [userListStatus, setUserListStatus] = useState<string | null>(null);
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

  // Left-click: pick from the user's cached list (fetching it first only
  // if nothing is cached). Right-click (forceRefresh): re-scrape the list
  // from AniList, then pick.
  const onRandomUserList = async (forceRefresh: boolean) => {
    const handle = username.trim();
    if (handle.length === 0) {
      onError('Enter an AniList username first.');
      return;
    }
    setApiLoading(true);
    onError(null);
    setUserListStatus(
      forceRefresh ? `Re-fetching ${handle}’s list…` : `Loading ${handle}’s list…`,
    );
    try {
      const result = await pickRandomAnimeFromUserList(importCtx, handle, {
        forceRefresh,
        excludePlanning: true,
      });
      if (!result.user) {
        onError(`No AniList user named “${handle}”.`);
        return;
      }
      // Normalise the field to AniList's stored casing and remember it.
      setUsername(result.user.name);
      try {
        localStorage.setItem(ANILIST_USERNAME_LS_KEY, result.user.name);
      } catch {
        // Best-effort prefill — ignore storage failures (private mode, quota).
      }
      if (!result.media) {
        onError(`No started or finished anime on ${result.user.name}’s list.`);
        return;
      }
      onSelect(result.media);
    } catch (err) {
      if (err instanceof AnilistUnknownUserError) {
        onError(`No AniList user named “${handle}”.`);
      } else if (err instanceof AnilistScrapeLockHeldError) {
        onError('An AniList import is already running — try again in a moment.');
      } else {
        onError(err instanceof Error ? err.message : 'Could not pick from that list.');
      }
    } finally {
      setApiLoading(false);
      setUserListStatus(null);
    }
  };

  const busy = disabled || apiLoading;
  const userListButtonTitle = `Random from ${
    username.trim() || 'a user'
  }’s list — right-click to re-fetch first`;
  const previewTitle = media ? pickMediaTitle(media) : '—';
  const previewAnilistLink = bindAnilistMiddleClick(media ? anilistUrlForMedia(media) : null);

  return (
    <section className="page-section anime-to-anime-endpoint-card">
      <div className="anime-to-anime-endpoint-header">
        <h2 className="anime-to-anime-section-title">{label}</h2>
        <div className="anime-to-anime-endpoint-header-actions">
          <button
            type="button"
            className="btn small icon-only anime-to-anime-random-btn"
            disabled={busy}
            onClick={onRandomFromCache}
            title="Random from cache"
            aria-label="Random from cache"
          >
            <DatabaseIcon size={16} />
          </button>
          <button
            type="button"
            className="btn small icon-only anime-to-anime-random-btn"
            disabled={busy}
            onClick={() => void onRandomApi()}
            title="Random from AniList"
            aria-label="Random from AniList"
          >
            <AnilistIcon size={16} />
          </button>
          <div className="anime-to-anime-endpoint-user">
            <input
              type="text"
              className="slot-search anime-to-anime-endpoint-user-input"
              placeholder="AniList username"
              value={username}
              disabled={busy}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void onRandomUserList(false);
                }
              }}
              aria-label="AniList username for random pick"
            />
            <button
              type="button"
              className="btn small icon-only anime-to-anime-random-btn"
              disabled={busy || username.trim().length === 0}
              onClick={() => void onRandomUserList(false)}
              onContextMenu={(e) => {
                e.preventDefault();
                void onRandomUserList(true);
              }}
              title={userListButtonTitle}
              aria-label={userListButtonTitle}
            >
              <UserIcon size={16} />
            </button>
          </div>
        </div>
      </div>

      {userListStatus && <p className="settings-status">{userListStatus}</p>}

      <div className="anime-to-anime-endpoint-inputs">
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
          <span className="anime-to-anime-endpoint-id-label">AniList ID</span>
          <div className="anime-to-anime-endpoint-id-row">
            <input
              type="number"
              className="slot-search"
              min={1}
              value={anilistId}
              disabled={busy}
              onChange={(e) => setAnilistId(e.target.value)}
              aria-label="AniList ID"
            />
            <button type="button" className="btn small" disabled={busy} onClick={() => void onLoadById()}>
              Load
            </button>
          </div>
        </div>
      </div>

      <div
        className={mergeAnilistLinkClass(
          'anime-to-anime-endpoint-preview',
          previewAnilistLink.className,
        )}
        title={previewAnilistLink.title}
        onMouseDown={previewAnilistLink.onMouseDown}
        onAuxClick={previewAnilistLink.onAuxClick}
      >
        {media?.cover_image && (
          <img src={media.cover_image} alt="" className="anime-to-anime-endpoint-cover" />
        )}
        <p className="anime-to-anime-endpoint-value">{previewTitle}</p>
      </div>
    </section>
  );
}
