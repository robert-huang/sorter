import { useCallback, useEffect, useState } from 'react';
import {
  AnilistScrapeLockHeldError,
  AnilistUnknownUserError,
} from '../lib/importers/anilist/importer';
import { ANILIST_SOURCE_ID } from '../lib/importers/anilist/anilistSource';
import { productionReads } from '../lib/importers/anilist/readQueries';
import {
  runAnilistFavourites,
  runAnilistImport,
} from '../lib/importers/anilist/runners';
import type {
  AnilistFavouriteType,
  AnilistMediaType,
} from '../lib/importers/anilist/types';
import { getSyncState, type SyncStatus } from '../lib/db/sync';
import { getPendingChanges } from '../lib/db/syncManifest';
import { getSourceIcon } from './sourceIcons';

/**
 * Gear-menu AniList source panel. Replaces the bare push/pull row from
 * sourceDatabasesSection for the AniList source specifically — exposes
 * the user-facing list/favourites refresh affordances + the pending-
 * changes / push-now affordance that lets per-entry refresh writes
 * make it to the cloud without piggybacking on a full import.
 *
 * Username handling: captured per-action via the inline input rather
 * than stored as a setting. Default-fills from localStorage on mount
 * (last typed value) and from the latest known anilist_user row in
 * the DB — whichever is freshest. NOT auto-saved on every keystroke;
 * only persisted after a successful import so a typo never overwrites
 * the last good value.
 */

const ANILIST_USERNAME_LS_KEY = 'anilist:lastUsername';

const FAVOURITE_TYPES: AnilistFavouriteType[] = [
  'CHARACTERS',
  'STAFF',
  'STUDIOS',
  'ANIME',
  'MANGA',
];

interface Props {
  cloudReady: boolean;
  pushing: boolean;
  pulling: boolean;
  error?: string;
  /** Bumps when any DB-affecting action lands so the panel re-reads
   *  its timestamps / pending counter / latest-user fields. */
  syncRevision: number;
  onPushSource: () => void;
  onPullSource: () => void;
}

function statusLabel(status: SyncStatus): string {
  switch (status) {
    case 'in-sync':
      return 'in sync';
    case 'drifted':
      return 'drifted';
    case 'unsynced':
      return 'unsynced';
    default:
      return 'unknown';
  }
}

function timeAgo(ms: number | null): string {
  if (ms === null) return '—';
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

interface RefreshTimestamps {
  /** Last-imported AniList user id (or null when no imports yet). */
  anilistUserId: number | null;
  /** Best-effort username for the last-imported user. */
  resolvedUsername: string | null;
  anime: number | null;
  manga: number | null;
  favourites: Record<AnilistFavouriteType, number | null>;
}

const EMPTY_TS: RefreshTimestamps = {
  anilistUserId: null,
  resolvedUsername: null,
  anime: null,
  manga: null,
  favourites: {
    CHARACTERS: null,
    STAFF: null,
    STUDIOS: null,
    ANIME: null,
    MANGA: null,
  },
};

async function loadTimestamps(): Promise<RefreshTimestamps> {
  const latest = await productionReads.getLatestAnilistUser();
  if (!latest) return EMPTY_TS;
  const [anime, manga, ...favs] = await Promise.all([
    productionReads.getLastFullRefresh(latest.id, 'ANIME'),
    productionReads.getLastFullRefresh(latest.id, 'MANGA'),
    ...FAVOURITE_TYPES.map((t) =>
      productionReads.getLastFavouritesRefresh(latest.id, t),
    ),
  ]);
  const favourites: Record<AnilistFavouriteType, number | null> = {
    CHARACTERS: null,
    STAFF: null,
    STUDIOS: null,
    ANIME: null,
    MANGA: null,
  };
  for (let i = 0; i < FAVOURITE_TYPES.length; i++) {
    favourites[FAVOURITE_TYPES[i]] = favs[i];
  }
  return {
    anilistUserId: latest.id,
    resolvedUsername: latest.name,
    anime,
    manga,
    favourites,
  };
}

export function AnilistSourcePanel({
  cloudReady,
  pushing,
  pulling,
  error,
  syncRevision,
  onPushSource,
  onPullSource,
}: Props) {
  const SourceIcon = getSourceIcon(ANILIST_SOURCE_ID);
  const sync = getSyncState(ANILIST_SOURCE_ID);
  const pendingChanges = getPendingChanges(ANILIST_SOURCE_ID);
  const busy = pushing || pulling;

  const [username, setUsername] = useState<string>(() => {
    try {
      return localStorage.getItem(ANILIST_USERNAME_LS_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [ts, setTs] = useState<RefreshTimestamps>(EMPTY_TS);
  // Three independent loading states so an in-flight anime refresh
  // doesn't disable the favourites Refresh button (they hit the same
  // scrape lock at the source layer — the importer surfaces a clear
  // AnilistScrapeLockHeldError if they conflict — but the UI gives
  // each its own spinner so the user can see what's happening).
  const [importingType, setImportingType] = useState<AnilistMediaType | null>(
    null,
  );
  const [favType, setFavType] =
    useState<AnilistFavouriteType>('CHARACTERS');
  const [refreshingFavs, setRefreshingFavs] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Pull fresh timestamps + latest-user on mount and whenever a DB-
  // affecting action lands. Default-fill the username from the latest
  // known anilist_user only if the input is empty (otherwise we'd
  // clobber the user's just-typed value).
  useEffect(() => {
    let cancelled = false;
    void loadTimestamps().then((next) => {
      if (cancelled) return;
      setTs(next);
      setUsername((cur) => {
        if (cur.trim() !== '') return cur;
        if (next.resolvedUsername) return next.resolvedUsername;
        return cur;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [syncRevision]);

  function flashError(err: unknown): void {
    if (err instanceof AnilistUnknownUserError) {
      setActionError(`AniList username "${err.username}" not found.`);
      return;
    }
    if (err instanceof AnilistScrapeLockHeldError) {
      setActionError('An import is already running — wait for it to finish.');
      return;
    }
    setActionError(err instanceof Error ? err.message : 'Action failed.');
  }

  const onImportList = useCallback(
    async (type: AnilistMediaType) => {
      const name = username.trim();
      if (!name || importingType !== null) return;
      setActionError(null);
      setImportingType(type);
      try {
        await runAnilistImport(name, type);
        try {
          localStorage.setItem(ANILIST_USERNAME_LS_KEY, name);
        } catch {
          /* private mode / quota — non-fatal */
        }
      } catch (err) {
        flashError(err);
      } finally {
        setImportingType(null);
      }
    },
    [username, importingType],
  );

  const onRefreshFavourites = useCallback(async () => {
    const name = username.trim();
    if (!name || refreshingFavs) return;
    setActionError(null);
    setRefreshingFavs(true);
    try {
      await runAnilistFavourites(name, favType);
      try {
        localStorage.setItem(ANILIST_USERNAME_LS_KEY, name);
      } catch {
        /* ignore */
      }
    } catch (err) {
      flashError(err);
    } finally {
      setRefreshingFavs(false);
    }
  }, [username, favType, refreshingFavs]);

  const canImport = cloudReady && username.trim() !== '' && !busy;

  return (
    <div className="settings-source-db-row settings-anilist-panel">
      <div className="settings-source-db-head">
        <span className="settings-source-db-name">
          <SourceIcon size={16} className="settings-source-db-icon" />
          <span>AniList</span>
        </span>
        <span className="settings-source-db-status" title="Sync status">
          {statusLabel(sync.status)}
        </span>
      </div>

      <div className="settings-anilist-username-row">
        <label className="settings-anilist-label" htmlFor="anilist-username">
          Username
        </label>
        <input
          id="anilist-username"
          className="settings-anilist-input"
          type="text"
          value={username}
          placeholder={ts.resolvedUsername ?? 'AniList username'}
          onChange={(e) => setUsername(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <div className="settings-anilist-action-row">
        <button
          type="button"
          className="settings-item"
          disabled={!canImport || importingType !== null}
          onClick={() => void onImportList('ANIME')}
          title={`Anime list · refreshed ${timeAgo(ts.anime)}`}
        >
          {importingType === 'ANIME' ? 'Refreshing anime…' : 'Refresh anime'}
        </button>
        <span className="settings-anilist-sub">refreshed {timeAgo(ts.anime)}</span>
      </div>

      <div className="settings-anilist-action-row">
        <button
          type="button"
          className="settings-item"
          disabled={!canImport || importingType !== null}
          onClick={() => void onImportList('MANGA')}
          title={`Manga list · refreshed ${timeAgo(ts.manga)}`}
        >
          {importingType === 'MANGA' ? 'Refreshing manga…' : 'Refresh manga'}
        </button>
        <span className="settings-anilist-sub">refreshed {timeAgo(ts.manga)}</span>
      </div>

      <div className="settings-anilist-action-row">
        <label className="settings-anilist-label" htmlFor="anilist-fav-type">
          Favourites
        </label>
        <select
          id="anilist-fav-type"
          className="settings-anilist-select"
          value={favType}
          onChange={(e) => setFavType(e.target.value as AnilistFavouriteType)}
        >
          {FAVOURITE_TYPES.map((t) => (
            <option key={t} value={t}>
              {favouriteLabel(t)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="settings-item"
          disabled={!canImport || refreshingFavs}
          onClick={() => void onRefreshFavourites()}
          title={`refreshed ${timeAgo(ts.favourites[favType])}`}
        >
          {refreshingFavs ? 'Refreshing…' : 'Refresh'}
        </button>
        <span className="settings-anilist-sub">
          {favouriteLabel(favType).toLowerCase()} ·{' '}
          {timeAgo(ts.favourites[favType])}
        </span>
      </div>

      {pendingChanges > 0 && (
        <div className="settings-anilist-pending">
          <span>
            {pendingChanges} pending change{pendingChanges === 1 ? '' : 's'}
            {' '}— per-entry refreshes need a manual push.
          </span>
          <button
            type="button"
            className="settings-item primary"
            disabled={busy || !cloudReady}
            onClick={onPushSource}
          >
            {pushing ? 'Pushing…' : 'Push now'}
          </button>
        </div>
      )}

      <div className="settings-source-db-meta">
        <span>Pushed: {timeAgo(sync.lastPushAt)}</span>
        <span>Pulled: {timeAgo(sync.lastPullAt)}</span>
      </div>

      {(error || actionError) && (
        <div className="settings-source-db-error" role="alert">
          {actionError ?? error}
        </div>
      )}

      <div className="settings-source-db-actions">
        <button
          type="button"
          className="settings-item"
          disabled={busy}
          onClick={onPushSource}
          title="Push the local anilist.sqlite to your cloud folder"
        >
          {pushing ? 'Pushing…' : 'Push'}
        </button>
        <button
          type="button"
          className="settings-item"
          disabled={busy}
          onClick={onPullSource}
          title="Replace the local anilist.sqlite with the cloud copy"
        >
          {pulling ? 'Pulling…' : 'Pull'}
        </button>
      </div>
    </div>
  );
}
