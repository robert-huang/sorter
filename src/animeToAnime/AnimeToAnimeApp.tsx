import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as client from '../lib/db/client';
import { ANILIST_SOURCE_ID } from '../lib/importers/anilist/anilistSource';
import { makeAnilistImportContext } from '../lib/importers/anilist/context';
import {
  ensureMediaCastExpanded,
  ensureMediaRelations,
  ensureStaffFilmography,
} from '../lib/importers/anilist/ensureGraph';
import {
  describeAnimeRandomPickFailure,
  getAnimeCacheStats,
  getAnimeFilmographyForStaff,
  getMediaRelations,
  getProductionCreditsAtMedia,
  getVaCreditsAtMedia,
  pickRandomAnimeFromCache,
  type AnimeCacheStats,
  type AnimeFilmographyRow,
  type MediaRelationRow,
  type ProductionCreditRow,
  type VaCreditRow,
} from '../lib/importers/anilist/graphQueries';
import type { StorageMode } from '../lib/db/opfs';
import { productionReads } from '../lib/importers/anilist/readQueries';
import type { MediaRow, StaffRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import {
  subscribeToWaitState,
  type AnilistWaitState,
} from '../lib/importers/anilist/transport';
import { AppNavFab } from '../components/AppNavFab';
import { SORTER_HOME_HREF } from '../lib/appRoutes';
import { AnimeToAnimeHeader } from './AnimeToAnimeHeader';
import { RoundEndpointsRow } from './RoundEndpointsRow';
import { PathHistoryTrail } from './PathHistoryTrail';
import { WinScreen } from './WinScreen';
import { type PathStep } from './pathHistory';
import {
  loadVaListImageMode,
  saveVaListImageMode,
  type VaListImageMode,
} from './preferences';
import {
  applyAnimeToAnimeTheme,
  loadAnimeToAnimeTheme,
  saveAnimeToAnimeTheme,
  type AnimeToAnimeTheme,
} from './theme';
import { VaCreditHopButton } from './VaCreditHopButton';

type Node =
  | { kind: 'anime'; mediaId: number }
  | { kind: 'staff'; staffId: number };

type RoundConfig = {
  allowProduction: boolean;
  allowRelations: boolean;
  productionAllRoles: boolean;
};

const ROUND_CONFIG_KEY = 'anime-to-anime-round-config';
const LEGACY_ROUND_CONFIG_KEY = 'link-game-round-config';

function loadRoundConfig(): RoundConfig {
  const defaults: RoundConfig = {
    allowProduction: true,
    allowRelations: false,
    productionAllRoles: false,
  };
  try {
    const raw =
      localStorage.getItem(ROUND_CONFIG_KEY) ?? localStorage.getItem(LEGACY_ROUND_CONFIG_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<RoundConfig>;
    return {
      allowProduction: parsed.allowProduction !== false,
      allowRelations: parsed.allowRelations === true,
      productionAllRoles: parsed.productionAllRoles === true,
    };
  } catch {
    return defaults;
  }
}

function saveRoundConfig(config: RoundConfig): void {
  try {
    localStorage.setItem(ROUND_CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

function animePathStep(media: MediaRow): PathStep {
  return {
    kind: 'anime',
    mediaId: media.id,
    title: pickMediaTitle(media),
    coverImage: media.cover_image,
  };
}

function staffPathStep(staff: StaffRow): PathStep {
  return {
    kind: 'staff',
    staffId: staff.id,
    name: staff.name_full ?? staff.name_native ?? 'Staff',
    image: staff.image,
  };
}

export function AnimeToAnimeApp() {
  const importCtx = useRef(makeAnilistImportContext());
  const [theme, setTheme] = useState<AnimeToAnimeTheme>(loadAnimeToAnimeTheme);
  const [vaListImageMode, setVaListImageMode] = useState<VaListImageMode>(loadVaListImageMode);
  const [ready, setReady] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>('opfs');
  const [cacheStats, setCacheStats] = useState<AnimeCacheStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startMedia, setStartMedia] = useState<MediaRow | null>(null);
  const [goalMedia, setGoalMedia] = useState<MediaRow | null>(null);
  const [roundConfig, setRoundConfig] = useState<RoundConfig>(loadRoundConfig);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [phase, setPhase] = useState<'setup' | 'play' | 'won'>('setup');
  const [current, setCurrent] = useState<Node | null>(null);
  const [animeHops, setAnimeHops] = useState(0);
  const [pathHistory, setPathHistory] = useState<PathStep[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiWait, setApiWait] = useState<AnilistWaitState | null>(null);

  const [vaCredits, setVaCredits] = useState<VaCreditRow[]>([]);
  const [productionCredits, setProductionCredits] = useState<ProductionCreditRow[]>([]);
  const [relations, setRelations] = useState<MediaRelationRow[]>([]);
  const [filmography, setFilmography] = useState<AnimeFilmographyRow[]>([]);
  const [staffHeader, setStaffHeader] = useState<StaffRow | null>(null);
  const [currentMedia, setCurrentMedia] = useState<MediaRow | null>(null);

  useEffect(() => {
    applyAnimeToAnimeTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (phase === 'setup') {
      setAdvancedOpen(false);
    }
  }, [phase]);

  useEffect(() => {
    return subscribeToWaitState((state) => {
      setApiWait(state);
    });
  }, []);

  const onToggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: AnimeToAnimeTheme = prev === 'dark' ? 'light' : 'dark';
      saveAnimeToAnimeTheme(next);
      return next;
    });
  }, []);

  const onVaListImageModeChange = useCallback((mode: VaListImageMode) => {
    setVaListImageMode(mode);
    saveVaListImageMode(mode);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { storageMode: mode } = await client.openSourceDb(ANILIST_SOURCE_ID);
        setStorageMode(mode);
        const stats = await getAnimeCacheStats(importCtx.current.db);
        setCacheStats(stats);
        setReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open database.');
      }
    })();
  }, []);

  const onRoundConfigChange = useCallback((patch: Partial<RoundConfig>) => {
    setRoundConfig((prev) => {
      const next = { ...prev, ...patch };
      saveRoundConfig(next);
      return next;
    });
  }, []);

  const randomizeEndpoint = useCallback(
    async (which: 'start' | 'goal') => {
      const db = importCtx.current.db;
      const row = await pickRandomAnimeFromCache(db);
      if (!row) {
        const stats = cacheStats ?? (await getAnimeCacheStats(db));
        setCacheStats(stats);
        setError(describeAnimeRandomPickFailure({ stats, storageMode }));
        return;
      }
      setError(null);
      if (which === 'start') {
        setStartMedia(row);
      } else {
        setGoalMedia(row);
      }
    },
    [cacheStats, storageMode],
  );

  const resetPlayState = useCallback((start: MediaRow) => {
    setFilter('');
    setVaCredits([]);
    setProductionCredits([]);
    setRelations([]);
    setFilmography([]);
    setStaffHeader(null);
    setCurrentMedia(null);
    setCurrent({ kind: 'anime', mediaId: start.id });
    setAnimeHops(0);
    setPathHistory([animePathStep(start)]);
  }, []);

  const beginRound = useCallback(() => {
    if (!startMedia || !goalMedia) {
      setError('Pick start and goal first.');
      return;
    }
    if (startMedia.id === goalMedia.id) {
      setError('Start and goal must differ. Re-roll goal.');
      return;
    }
    setError(null);
    setPhase('play');
    resetPlayState(startMedia);
  }, [startMedia, goalMedia, resetPlayState]);

  const swapStartGoal = useCallback(() => {
    if (!startMedia || !goalMedia) {
      return;
    }
    const nextStart = goalMedia;
    const nextGoal = startMedia;
    setStartMedia(nextStart);
    setGoalMedia(nextGoal);
    if (phase === 'play' || phase === 'won') {
      setError(null);
      setPhase('play');
      resetPlayState(nextStart);
    }
  }, [startMedia, goalMedia, phase, resetPlayState]);

  const onPlayAgain = useCallback(() => {
    if (!startMedia || !goalMedia) {
      return;
    }
    setError(null);
    setPhase('play');
    resetPlayState(startMedia);
  }, [startMedia, goalMedia, resetPlayState]);

  const goToSetup = useCallback(() => {
    setPhase('setup');
    setCurrent(null);
    setPathHistory([]);
    setAnimeHops(0);
    setFilter('');
  }, []);

  useEffect(() => {
    if (phase !== 'play' || !current) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const ctx = importCtx.current;
      try {
        if (current.kind === 'anime') {
          await ensureMediaCastExpanded(ctx, current.mediaId);
          if (roundConfig.allowRelations) {
            await ensureMediaRelations(ctx, current.mediaId);
          }
          const mediaRows = await productionReads.getMediaByIds([current.mediaId]);
          const va = await getVaCreditsAtMedia(ctx.db, current.mediaId);
          const prod = roundConfig.allowProduction
            ? await getProductionCreditsAtMedia(
                ctx.db,
                current.mediaId,
                roundConfig.productionAllRoles ? 'all' : 'key',
              )
            : [];
          const rel = roundConfig.allowRelations
            ? await getMediaRelations(ctx.db, current.mediaId)
            : [];
          if (cancelled) return;
          setCurrentMedia(mediaRows[0] ?? null);
          setVaCredits(va);
          setProductionCredits(prod);
          setRelations(rel);
          setFilmography([]);
          setStaffHeader(null);
        } else {
          await ensureStaffFilmography(ctx, current.staffId);
          const staffRows = await ctx.db.exec('SELECT * FROM staff WHERE id = ?', [
            current.staffId,
          ]);
          const film = await getAnimeFilmographyForStaff(
            ctx.db,
            current.staffId,
            roundConfig.productionAllRoles ? 'all' : 'key',
          );
          if (cancelled) return;
          setStaffHeader(
            staffRows.length > 0
              ? {
                  id: Number(staffRows[0].id),
                  name_full: staffRows[0].name_full as string | null,
                  name_native: staffRows[0].name_native as string | null,
                  image: staffRows[0].image as string | null,
                  age: staffRows[0].age as string | null,
                  gender: staffRows[0].gender as string | null,
                  language_v2: staffRows[0].language_v2 as string | null,
                  favourites:
                    staffRows[0].favourites === null
                      ? null
                      : Number(staffRows[0].favourites),
                  fetched_at: Number(staffRows[0].fetched_at),
                  updated_at: Number(staffRows[0].updated_at),
                }
              : null,
          );
          setFilmography(film);
          setVaCredits([]);
          setProductionCredits([]);
          setRelations([]);
          setCurrentMedia(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Load failed.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    current,
    phase,
    roundConfig.allowProduction,
    roundConfig.allowRelations,
    roundConfig.productionAllRoles,
  ]);

  const filterLower = filter.trim().toLowerCase();

  const filteredVa = useMemo(() => {
    if (!filterLower) return vaCredits;
    return vaCredits.filter((row) => {
      const va = row.staff.name_full ?? row.staff.name_native ?? '';
      const ch = row.character.name_full ?? row.character.name_native ?? '';
      return va.toLowerCase().includes(filterLower) || ch.toLowerCase().includes(filterLower);
    });
  }, [vaCredits, filterLower]);

  const filteredProd = useMemo(() => {
    if (!filterLower) return productionCredits;
    return productionCredits.filter((row) => {
      const name = row.staff.name_full ?? row.staff.name_native ?? '';
      return name.toLowerCase().includes(filterLower) || row.role.toLowerCase().includes(filterLower);
    });
  }, [productionCredits, filterLower]);

  const filteredRelations = useMemo(() => {
    if (!filterLower) return relations;
    return relations.filter((row) => {
      const label = pickMediaTitle(row.media);
      return (
        label.toLowerCase().includes(filterLower) ||
        row.relationType.toLowerCase().includes(filterLower)
      );
    });
  }, [relations, filterLower]);

  const filteredFilmography = useMemo(() => {
    if (!filterLower) return filmography;
    return filmography.filter((row) => {
      const label = pickMediaTitle(row.media);
      return label.toLowerCase().includes(filterLower) || row.role.toLowerCase().includes(filterLower);
    });
  }, [filmography, filterLower]);

  const onHopToStaff = useCallback((staff: StaffRow) => {
    setPathHistory((prev) => [...prev, staffPathStep(staff)]);
    setCurrent({ kind: 'staff', staffId: staff.id });
  }, []);

  const onHopToAnime = useCallback(
    (media: MediaRow) => {
      setAnimeHops((h) => h + 1);
      setPathHistory((prev) => [...prev, animePathStep(media)]);
      setCurrent({ kind: 'anime', mediaId: media.id });
      if (goalMedia && media.id === goalMedia.id) {
        setPhase('won');
      }
    },
    [goalMedia],
  );

  const endpointsSwapDisabled = !startMedia || !goalMedia;

  const apiWaitBanner =
    apiWait && (
      <div className="app-banner warn">
        <span>
          AniList rate limit — retrying in {Math.ceil(apiWait.retryInMs / 1000)}s (attempt{' '}
          {apiWait.attempt})
        </span>
      </div>
    );

  return (
    <div className="app-shell">
      <AppNavFab href={SORTER_HOME_HREF} label="← Sorter" title="Back to Sorter" />
      <AnimeToAnimeHeader
        theme={theme}
        vaListImageMode={vaListImageMode}
        onToggleTheme={onToggleTheme}
        onVaListImageModeChange={onVaListImageModeChange}
      />

      {ready && storageMode === 'memory' && (
        <div className="app-banner warn">
          <span>
            This tab is using in-memory storage (OPFS unavailable or this browser cannot
            share the database worker). Import on the main Sorter page, or reload after
            closing other tabs if you see a non-persistent warning there.
          </span>
        </div>
      )}

      {apiWaitBanner}

      {!ready ? (
        <main className="page anime-to-anime-page">
          <p className="settings-status">{error ?? 'Opening database…'}</p>
        </main>
      ) : phase === 'setup' ? (
        <main className="page anime-to-anime-page">
          <h1>Anime to Anime</h1>
          <p className="anime-to-anime-lead">
            Connect start → goal through voice actors and optional production staff.
            {cacheStats && cacheStats.animeCount > 0 && (
              <>
                {' '}
                {cacheStats.animeCount.toLocaleString()} anime in local cache.
              </>
            )}
          </p>
          {error && (
            <p role="alert" className="settings-source-db-error">
              {error}
            </p>
          )}

          <RoundEndpointsRow
            phase="setup"
            startMedia={startMedia}
            goalMedia={goalMedia}
            swapDisabled={endpointsSwapDisabled}
            importCtx={importCtx.current}
            onSelectStart={(media) => {
              setError(null);
              setStartMedia(media);
            }}
            onSelectGoal={(media) => {
              setError(null);
              setGoalMedia(media);
            }}
            onEndpointError={setError}
            onRandomStart={() => void randomizeEndpoint('start')}
            onRandomGoal={() => void randomizeEndpoint('goal')}
            onSwap={swapStartGoal}
          />

          <section className="page-section anime-to-anime-advanced">
            {!advancedOpen ? (
              <button
                type="button"
                className="link-btn"
                onClick={() => setAdvancedOpen(true)}
              >
                Advanced
              </button>
            ) : (
              <>
                <div className="edit-item-advanced-header">
                  <span className="edit-item-advanced-title">Advanced</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setAdvancedOpen(false)}
                  >
                    Hide
                  </button>
                </div>
                <label className="settings-item checkbox">
                  <input
                    type="checkbox"
                    checked={roundConfig.allowProduction}
                    onChange={(e) => onRoundConfigChange({ allowProduction: e.target.checked })}
                  />
                  Production credits
                </label>
                <label className="settings-item checkbox">
                  <input
                    type="checkbox"
                    checked={roundConfig.productionAllRoles}
                    onChange={(e) =>
                      onRoundConfigChange({ productionAllRoles: e.target.checked })
                    }
                  />
                  All production roles
                </label>
                <label className="settings-item checkbox">
                  <input
                    type="checkbox"
                    checked={roundConfig.allowRelations}
                    onChange={(e) => onRoundConfigChange({ allowRelations: e.target.checked })}
                  />
                  Franchise relations mode
                </label>
              </>
            )}
          </section>

          <div className="anime-to-anime-primary-action">
            <button type="button" className="btn primary" onClick={beginRound}>
              Start round
            </button>
          </div>
        </main>
      ) : (
        <main className="page anime-to-anime-page">
          <RoundEndpointsRow
            phase={phase === 'won' ? 'won' : 'play'}
            startMedia={startMedia}
            goalMedia={goalMedia}
            animeHops={animeHops}
            swapDisabled={endpointsSwapDisabled}
            onRandomStart={() => void randomizeEndpoint('start')}
            onRandomGoal={() => void randomizeEndpoint('goal')}
            onSwap={swapStartGoal}
          />

          {phase === 'play' && pathHistory.length > 0 && (
            <PathHistoryTrail steps={pathHistory} />
          )}

          {phase === 'won' && startMedia && goalMedia && (
            <WinScreen
              startMedia={startMedia}
              goalMedia={goalMedia}
              animeHops={animeHops}
              pathHistory={pathHistory}
              onPlayAgain={onPlayAgain}
              onSetup={goToSetup}
            />
          )}

          {phase === 'play' && (
            <div className="anime-to-anime-play-toolbar">
              <button type="button" className="btn small" onClick={goToSetup}>
                Setup
              </button>
            </div>
          )}

          {error && (
            <p role="alert" className="settings-source-db-error">
              {error}
            </p>
          )}

          {phase === 'play' && (
            <>
              <input
                type="search"
                className="slot-search anime-to-anime-search"
                placeholder="Filter list…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />

              {loading && <p className="settings-status">Loading…</p>}

              {current?.kind === 'anime' && currentMedia && (
                <section className="page-section">
                  <h2 className="anime-to-anime-current-title">{pickMediaTitle(currentMedia)}</h2>
                  {roundConfig.allowRelations && (
                    <>
                      <h3 className="anime-to-anime-subheading">Related anime</h3>
                      <ul className="anilist-detail-cast-list">
                        {filteredRelations.map((row) => (
                          <li key={`${row.media.id}-${row.relationType}`} className="anilist-detail-cast-item">
                            <button
                              type="button"
                              className="btn link anime-to-anime-hop-btn"
                              onClick={() => onHopToAnime(row.media)}
                            >
                              {pickMediaTitle(row.media)}
                              <span className="anime-to-anime-hop-meta">{row.relationType}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <h3 className="anime-to-anime-subheading">Voice actors</h3>
                  <ul className="anilist-detail-cast-list">
                    {filteredVa.map((row) => (
                      <li
                        key={`${row.staff.id}-${row.character.id}`}
                        className="anilist-detail-cast-item anime-to-anime-va-item"
                      >
                        <VaCreditHopButton
                          row={row}
                          vaListImageMode={vaListImageMode}
                          onHop={() => onHopToStaff(row.staff)}
                        />
                      </li>
                    ))}
                  </ul>
                  {roundConfig.allowProduction && (
                    <>
                      <h3 className="anime-to-anime-subheading">Production</h3>
                      <ul className="anilist-detail-cast-list">
                        {filteredProd.map((row) => (
                          <li
                            key={`${row.staff.id}-${row.role}`}
                            className="anilist-detail-cast-item"
                          >
                            <button
                              type="button"
                              className="btn link anime-to-anime-hop-btn"
                              onClick={() => onHopToStaff(row.staff)}
                            >
                              {row.staff.name_full ?? row.staff.name_native} — {row.role}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}

              {current?.kind === 'staff' && staffHeader && (
                <section className="page-section">
                  <h2 className="anime-to-anime-current-title">
                    {staffHeader.name_full ?? staffHeader.name_native}
                  </h2>
                  <h3 className="anime-to-anime-subheading">Filmography (anime)</h3>
                  <ul className="anilist-detail-cast-list">
                    {filteredFilmography.map((row) => (
                      <li
                        key={`${row.media.id}-${row.role}`}
                        className="anilist-detail-cast-item"
                      >
                        <button
                          type="button"
                          className="btn link anime-to-anime-hop-btn"
                          onClick={() => onHopToAnime(row.media)}
                        >
                          {pickMediaTitle(row.media)}
                          <span className="anime-to-anime-hop-meta">{row.role}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </main>
      )}
    </div>
  );
}
