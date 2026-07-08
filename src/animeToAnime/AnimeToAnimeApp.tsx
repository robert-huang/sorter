import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as client from '../lib/db/client';
import { ANILIST_SOURCE_ID } from '../lib/importers/anilist/anilistSource';
import { makeAnilistImportContext } from '../lib/importers/anilist/context';
import { ensureMediaRelations } from '../lib/importers/anilist/ensureGraph';
import {
  ensureMediaCastFreshWithContext,
  ensureStaffFilmographyFreshWithContext,
} from '../lib/importers/anilist/toolsAnilistAccess';
import {
  describeAnimeRandomPickFailure,
  getAnimeCacheStats,
  getAnimeFilmographyForStaff,
  getMediaRelations,
  getProductionCreditsAtMedia,
  getStaffFilmographyFetchedAt,
  getVaCreditsAtMedia,
  pickRandomAnimeFromCache,
  type AnimeCacheStats,
  type AnimeFilmographyRow,
  type MediaRelationRow,
  type ProductionCreditRow,
  type VaCreditRow,
} from '../lib/importers/anilist/graphQueries';
import { describeNonPersistentStorageBanner, type StorageMode } from '../lib/db/opfs';
import { readSettings, updateSettings } from '../lib/storage';
import { productionReads } from '../lib/importers/anilist/readQueries';
import type { MediaRow, StaffRow } from '../lib/importers/anilist/types';
import { useAnilistDisplayPreferences } from '../hooks/useAnilistDisplayPreferences';
import { useHistoryBackGuard } from '../hooks/useHistoryBackGuard';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { pickPersonName } from '../lib/importers/anilist/personDisplayLabel';
import {
  graphStaleRefreshTooltip,
  isGraphTimestampStale,
  oldestStaleGraphTimestamp,
} from '../lib/importers/anilist/graphConstants';
import {
  subscribeToWaitState,
  type AnilistWaitState,
} from '../lib/importers/anilist/transport';
import { AppBannerStack } from '../components/AppBannerStack';
import { AnilistDetailModal } from '../components/AnilistDetailModal';
import { StaffDetailModal } from '../components/StaffDetailModal';
import { useAnilistWaitCountdown } from '../hooks/useAnilistWaitCountdown';
import { useSourceDbSync } from '../hooks/useSourceDbSync';
import { AnimeToAnimeHeader } from './AnimeToAnimeHeader';
import { RoundEndpointsRow } from './RoundEndpointsRow';
import { PathHistoryTrail } from './PathHistoryTrail';
import { ExitRoundConfirmModal } from './ExitRoundConfirmModal';
import { GiveUpConfirmModal } from './GiveUpConfirmModal';
import {
  buildCachedRouteStream,
  type BuildCachedRouteStream,
} from './cachedGraph';
import { WinScreen } from './WinScreen';
import { type PathHopCharacter, type PathStep } from './pathHistory';
import {
  charactersFromVaGroup,
  viaLabelFromFilmography,
  viaLabelFromProduction,
  viaLabelFromRelation,
  viaLabelFromVaGroup,
} from './pathHopLabels';
import {
  loadRoundConfig,
  loadStaffGenderFilter,
  loadVaListImageMode,
  matchesStaffGender,
  mergeLiveProductionRules,
  playListTitleWithStaffGenderFilter,
  staffGenderFilterListHint,
  saveRoundConfig,
  saveStaffGenderFilter,
  saveVaListImageMode,
  type RoundConfig,
  type StaffGenderFilter,
  type VaListImageMode,
} from './preferences';
import {
  applyAnimeToAnimeTheme,
  loadAnimeToAnimeTheme,
  saveAnimeToAnimeTheme,
  type AnimeToAnimeTheme,
} from './theme';
import { bindAnilistMiddleClick, anilistUrlForMedia, mergeAnilistLinkClass } from './anilistMiddleClick';
import { StaffFilmographySections } from './StaffFilmographySections';
import { PlayListSectionHeader } from './PlayListSectionHeader';
import { ProductionCreditHopButton } from './ProductionCreditHopButton';
import { VaCreditHopButton } from './VaCreditHopButton';
import {
  groupSortedVaCredits,
  type GroupedVaCreditRow,
} from './vaCreditDisplay';
import {
  filmographyFilterParts,
  groupedVaCreditFilterParts,
  matchesListFilter,
  mediaRelationFilterParts,
  productionCreditFilterParts,
} from './listFilter';

type Node =
  | { kind: 'anime'; mediaId: number }
  | { kind: 'staff'; staffId: number };

function animePathStep(
  media: MediaRow,
  viaLabel?: string,
  viaCharacters?: readonly PathHopCharacter[],
): PathStep {
  const titleFields = {
    id: media.id,
    title_romaji: media.title_romaji,
    title_english: media.title_english,
    title_native: media.title_native,
  };
  return {
    kind: 'anime',
    mediaId: media.id,
    title: pickMediaTitle(titleFields),
    coverImage: media.cover_image,
    titleFields,
    ...(viaLabel ? { viaLabel } : {}),
    ...(viaCharacters && viaCharacters.length > 0 ? { viaCharacters } : {}),
  };
}

function staffPathStep(
  staff: StaffRow,
  viaLabel?: string,
  viaCharacters?: readonly PathHopCharacter[],
): PathStep {
  const nameFields = {
    id: staff.id,
    name_full: staff.name_full,
    name_native: staff.name_native,
  };
  return {
    kind: 'staff',
    staffId: staff.id,
    name: pickPersonName(nameFields, undefined, 'Staff'),
    image: staff.image,
    nameFields,
    ...(viaLabel ? { viaLabel } : {}),
    ...(viaCharacters && viaCharacters.length > 0 ? { viaCharacters } : {}),
  };
}

export function AnimeToAnimeApp() {
  const { prefs: anilistDisplayPrefs } = useAnilistDisplayPreferences();
  const dbSync = useSourceDbSync();
  const bumpSourceDbDirtyRef = useRef(dbSync.bumpSourceDbDirty);
  bumpSourceDbDirtyRef.current = dbSync.bumpSourceDbDirty;
  const importCtx = useRef(
    makeAnilistImportContext({
      onDirtyIncrement: async () => {
        bumpSourceDbDirtyRef.current(ANILIST_SOURCE_ID);
      },
    }),
  );
  const [theme, setTheme] = useState<AnimeToAnimeTheme>(loadAnimeToAnimeTheme);
  const [vaListImageMode, setVaListImageMode] = useState<VaListImageMode>(loadVaListImageMode);
  const [genderFilter, setGenderFilter] = useState<StaffGenderFilter>(loadStaffGenderFilter);
  const [ready, setReady] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>('opfs');
  const [storageHint, setStorageHint] = useState<string | null>(null);
  const [opfsLockContendedByOtherTab, setOpfsLockContendedByOtherTab] = useState(false);
  const [cacheStats, setCacheStats] = useState<AnimeCacheStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startMedia, setStartMedia] = useState<MediaRow | null>(null);
  const [goalMedia, setGoalMedia] = useState<MediaRow | null>(null);
  const [roundConfig, setRoundConfig] = useState<RoundConfig>(loadRoundConfig);
  const [historyBackGuard, setHistoryBackGuard] = useState(
    () => !!readSettings().historyBackGuard,
  );
  /** Snapshotted from persisted settings when a round begins. */
  const [activeRoundConfig, setActiveRoundConfig] = useState<RoundConfig | null>(null);
  const [phase, setPhase] = useState<'setup' | 'play' | 'won' | 'gave_up'>('setup');
  const [current, setCurrent] = useState<Node | null>(null);
  const [linksUsed, setLinksUsed] = useState(0);
  const [pathHistory, setPathHistory] = useState<PathStep[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  // Relabel the trail's node titles / names in place when the display
  // preference changes mid-round. The `viaLabel` edge tooltips embed
  // character/role text resolved at hop time and aren't re-derived here
  // (that would need a DB requery) — only the node labels flip.
  useEffect(() => {
    setPathHistory((prev) => {
      let changed = false;
      const next = prev.map((step) => {
        if (step.kind === 'anime' && step.titleFields) {
          const title = pickMediaTitle(step.titleFields);
          if (title === step.title) return step;
          changed = true;
          return { ...step, title };
        }
        if (step.kind === 'staff' && step.nameFields) {
          const name = pickPersonName(step.nameFields, undefined, 'Staff');
          if (name === step.name) return step;
          changed = true;
          return { ...step, name };
        }
        return step;
      });
      return changed ? next : prev;
    });
  }, [anilistDisplayPrefs.mediaTitleMode, anilistDisplayPrefs.personNameMode]);
  const [apiWait, setApiWait] = useState<AnilistWaitState | null>(null);
  const apiWaitSecondsLeft = useAnilistWaitCountdown(apiWait);
  const [listRefreshEpoch, setListRefreshEpoch] = useState(0);
  const [exitRoundConfirmOpen, setExitRoundConfirmOpen] = useState(false);
  const [giveUpConfirmOpen, setGiveUpConfirmOpen] = useState(false);
  const forceListRefreshRef = useRef(false);

  const [vaCredits, setVaCredits] = useState<VaCreditRow[]>([]);
  const [productionCredits, setProductionCredits] = useState<ProductionCreditRow[]>([]);
  const [relations, setRelations] = useState<MediaRelationRow[]>([]);
  const [filmography, setFilmography] = useState<AnimeFilmographyRow[]>([]);
  const [staffHeader, setStaffHeader] = useState<StaffRow | null>(null);
  // When non-null, the current anime's cached cast/staff expansion is older
  // than the staleness threshold (>90d) — highlights the cast refresh button.
  const [currentCastStaleFetchedAt, setCurrentCastStaleFetchedAt] = useState<
    number | null
  >(null);
  const [staffFilmographyFetchedAt, setStaffFilmographyFetchedAt] = useState<
    number | null
  >(null);
  const [currentMedia, setCurrentMedia] = useState<MediaRow | null>(null);
  // Latest cached AniList user id (null when no list cached) — gates the
  // staff-list "only items on my list" toggle, mirroring StaffDetailModal.
  const [listUserId, setListUserId] = useState<number | null>(null);
  // Media ids from the current staff filmography that are on the cached
  // user's list (anime or manga).
  const [myListMediaIds, setMyListMediaIds] = useState<Set<number>>(() => new Set());
  // When on, the staff filmography is restricted to items on the user's
  // list. Persists across hops within a session (not reset on navigation).
  const [onlyMyList, setOnlyMyList] = useState(false);
  // Detail-modal targets, opened from the result-screen path trail only.
  // Mirrors App.tsx's item/staff modal routing so a finished round can
  // drill into any node and cross-navigate between media and staff.
  const [itemDetailTarget, setItemDetailTarget] = useState<{
    mediaId: number;
    fallbackTitle: string;
  } | null>(null);
  const [staffDetailTarget, setStaffDetailTarget] = useState<{
    staffId: number;
    fallbackName: string;
  } | null>(null);

  useEffect(() => {
    applyAnimeToAnimeTheme(theme);
  }, [theme]);

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

  const onToggleHistoryBackGuard = useCallback(() => {
    setHistoryBackGuard((cur) => {
      const next = !cur;
      updateSettings({ historyBackGuard: next });
      return next;
    });
  }, []);

  const onVaListImageModeChange = useCallback((mode: VaListImageMode) => {
    setVaListImageMode(mode);
    saveVaListImageMode(mode);
  }, []);

  const onGenderFilterChange = useCallback((filter: StaffGenderFilter) => {
    setGenderFilter(filter);
    saveStaffGenderFilter(filter);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (await client.probeOpfsLockContended()) {
          setOpfsLockContendedByOtherTab(true);
        }
        const {
          storageMode: mode,
          storageHint: hint,
          opfsLockContendedByOtherTab: lockContended,
        } = await client.openSourceDb(ANILIST_SOURCE_ID);
        setStorageMode(mode);
        setStorageHint(hint ?? null);
        setOpfsLockContendedByOtherTab(lockContended);
        setReady(true);
        const stats = await getAnimeCacheStats(importCtx.current.db);
        setCacheStats(stats);
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

  const effectiveRoundRules = useMemo((): RoundConfig | null => {
    if (!activeRoundConfig) {
      return null;
    }
    return mergeLiveProductionRules(activeRoundConfig, roundConfig);
  }, [activeRoundConfig, roundConfig]);

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
    setCurrentCastStaleFetchedAt(null);
    setStaffFilmographyFetchedAt(null);
    setCurrent({ kind: 'anime', mediaId: start.id });
    setLinksUsed(0);
    setPathHistory([animePathStep(start)]);
  }, []);

  const snapshotRoundConfig = useCallback((): RoundConfig => {
    const config = loadRoundConfig();
    setActiveRoundConfig(config);
    return config;
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
    snapshotRoundConfig();
    setPhase('play');
    resetPlayState(startMedia);
  }, [startMedia, goalMedia, resetPlayState, snapshotRoundConfig]);

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

  const goToSetup = useCallback(() => {
    setPhase('setup');
    setActiveRoundConfig(null);
    setCurrent(null);
    setPathHistory([]);
    setLinksUsed(0);
    setFilter('');
    setError(null);
  }, []);

  const onPlayAgain = useCallback(() => {
    goToSetup();
  }, [goToSetup]);

  const onOpenPathStep = useCallback((step: PathStep) => {
    if (step.kind === 'anime') {
      setItemDetailTarget({ mediaId: step.mediaId, fallbackTitle: step.title });
    } else {
      setStaffDetailTarget({ staffId: step.staffId, fallbackName: step.name });
    }
  }, []);

  const onOpenMediaDetail = useCallback(
    (mediaId: number, fallbackTitle: string) => {
      setItemDetailTarget({ mediaId, fallbackTitle });
    },
    [],
  );

  const buildCachedPathStream = useCallback(
    async (maxLinks?: number): Promise<BuildCachedRouteStream> => {
      if (!startMedia || !goalMedia || !effectiveRoundRules) {
        return { status: 'not_found' };
      }
      return buildCachedRouteStream({
        db: importCtx.current.db,
        startMediaId: startMedia.id,
        goalMediaId: goalMedia.id,
        rules: effectiveRoundRules,
        maxLinks,
        genderFilter,
      });
    },
    [effectiveRoundRules, goalMedia, startMedia, genderFilter],
  );

  /** Win: prune BFS past the user's link count — can't beat a path shorter than that. */
  const onBuildCachedPathStreamForWin = useCallback(
    () => buildCachedPathStream(linksUsed),
    [buildCachedPathStream, linksUsed],
  );

  /** Give up: search full cache — user may have stopped before any anime hops. */
  const onBuildCachedPathStreamForGiveUp = useCallback(
    () => buildCachedPathStream(),
    [buildCachedPathStream],
  );

  const confirmExitToSetup = useCallback(() => {
    setExitRoundConfirmOpen(true);
  }, []);

  const onExitRoundConfirm = useCallback(() => {
    setExitRoundConfirmOpen(false);
    goToSetup();
  }, [goToSetup]);

  const onExitRoundCancel = useCallback(() => {
    setExitRoundConfirmOpen(false);
  }, []);

  useHistoryBackGuard(historyBackGuard && phase === 'play', confirmExitToSetup);

  const onGiveUpClick = useCallback(() => {
    setGiveUpConfirmOpen(true);
  }, []);

  const onGiveUpConfirm = useCallback(() => {
    setGiveUpConfirmOpen(false);
    setPhase('gave_up');
  }, []);

  const onGiveUpCancel = useCallback(() => {
    setGiveUpConfirmOpen(false);
  }, []);

  const onRefreshPlayList = useCallback(() => {
    forceListRefreshRef.current = true;
    setListRefreshEpoch((epoch) => epoch + 1);
  }, []);

  useEffect(() => {
    if (phase !== 'play' || !current || !effectiveRoundRules) {
      return;
    }
    const rules = effectiveRoundRules;
    const forceRefresh = forceListRefreshRef.current;
    forceListRefreshRef.current = false;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const ctx = importCtx.current;
      try {
        if (current.kind === 'anime') {
          await ensureMediaCastFreshWithContext(ctx, current.mediaId, {
            forceRefresh,
          });
          if (rules.allowRelations) {
            await ensureMediaRelations(ctx, current.mediaId, { force: forceRefresh });
          }
          const mediaRows = await productionReads.getMediaByIds([current.mediaId]);
          const va = await getVaCreditsAtMedia(ctx.db, current.mediaId);
          const prod = rules.allowProduction
            ? await getProductionCreditsAtMedia(
                ctx.db,
                current.mediaId,
                rules.productionAllRoles ? 'all' : 'key',
              )
            : [];
          const rel = rules.allowRelations
            ? await getMediaRelations(ctx.db, current.mediaId)
            : [];
          // Cheap single-row read of the cast/staff expansion timestamps so
          // the play-screen refresh button can flag a >90d-old cache, the
          // same way the media detail modal does.
          const castStatus = await productionReads.getMediaCastExpansionStatus(
            current.mediaId,
          );
          if (cancelled) return;
          setCurrentMedia(mediaRows[0] ?? null);
          setVaCredits(va);
          setProductionCredits(prod);
          setRelations(rel);
          setCurrentCastStaleFetchedAt(
            castStatus
              ? oldestStaleGraphTimestamp([
                  castStatus.charactersFetchedAt,
                  castStatus.staffFetchedAt,
                ])
              : null,
          );
          setStaffFilmographyFetchedAt(null);
          setFilmography([]);
          setStaffHeader(null);
          // The my-list toggle only applies to staff filmography lists.
          setMyListMediaIds(new Set());
        } else {
          await ensureStaffFilmographyFreshWithContext(ctx, current.staffId, {
            forceRefresh,
          });
          const staffRows = await ctx.db.exec('SELECT * FROM staff WHERE id = ?', [
            current.staffId,
          ]);
          const film = await getAnimeFilmographyForStaff(
            ctx.db,
            current.staffId,
            rules.productionAllRoles ? 'all' : 'key',
          );
          const filmFetchedAt = await getStaffFilmographyFetchedAt(
            ctx.db,
            current.staffId,
          );
          // Resolve which of this staff's works are on the cached user's
          // list so the "only items on my list" toggle can filter them.
          const listUser = await productionReads.getLatestAnilistUser();
          const myList =
            listUser && film.length > 0
              ? await productionReads.getMediaIdsInUserList(
                  listUser.id,
                  film.map((row) => row.media.id),
                )
              : new Set<number>();
          if (cancelled) return;
          setListUserId(listUser?.id ?? null);
          setMyListMediaIds(myList);
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
          setStaffFilmographyFetchedAt(filmFetchedAt);
          setVaCredits([]);
          setProductionCredits([]);
          setRelations([]);
          setCurrentMedia(null);
          setCurrentCastStaleFetchedAt(null);
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
  }, [effectiveRoundRules, current, listRefreshEpoch, phase]);

  const filterLower = filter.trim().toLowerCase();

  const groupedVa = useMemo(() => {
    const groups = groupSortedVaCredits(vaCredits);
    if (genderFilter === 'any') {
      return groups;
    }
    return groups.filter((group) => matchesStaffGender(group.staff.gender, genderFilter));
  }, [vaCredits, genderFilter]);

  const filteredVa = useMemo(() => {
    if (!filterLower) {
      return groupedVa;
    }
    return groupedVa.filter((group) =>
      matchesListFilter(groupedVaCreditFilterParts(group), filterLower),
    );
  }, [groupedVa, filterLower]);

  const filteredProd = useMemo(() => {
    const genderMatched =
      genderFilter === 'any'
        ? productionCredits
        : productionCredits.filter((row) => matchesStaffGender(row.staff.gender, genderFilter));
    if (!filterLower) {
      return genderMatched;
    }
    return genderMatched.filter((row) =>
      matchesListFilter(productionCreditFilterParts(row), filterLower),
    );
  }, [productionCredits, filterLower, genderFilter]);

  const filteredRelations = useMemo(() => {
    if (!filterLower) {
      return relations;
    }
    return relations.filter((row) =>
      matchesListFilter(mediaRelationFilterParts(row), filterLower),
    );
  }, [relations, filterLower]);

  const filteredFilmography = useMemo(() => {
    let rows: readonly AnimeFilmographyRow[] = filmography;
    if (onlyMyList) {
      rows = rows.filter((row) => myListMediaIds.has(row.media.id));
    }
    if (filterLower) {
      rows = rows.filter((row) =>
        matchesListFilter(filmographyFilterParts(row), filterLower),
      );
    }
    return rows;
  }, [filmography, filterLower, onlyMyList, myListMediaIds]);

  const currentAnimeAnilistLink = useMemo(() => {
    if (current?.kind !== 'anime' || !currentMedia) {
      return null;
    }
    return bindAnilistMiddleClick(anilistUrlForMedia(currentMedia));
  }, [current, currentMedia]);

  const onHopToStaff = useCallback(
    (staff: StaffRow, viaLabel: string, viaCharacters?: readonly PathHopCharacter[]) => {
      setFilter('');
      setPathHistory((prev) => [...prev, staffPathStep(staff, viaLabel, viaCharacters)]);
      setCurrent({ kind: 'staff', staffId: staff.id });
    },
    [],
  );

  const onHopToAnime = useCallback(
    (media: MediaRow, viaLabel: string, viaCharacters?: readonly PathHopCharacter[]) => {
      setFilter('');
      const reachedGoal = goalMedia !== null && media.id === goalMedia.id;
      setLinksUsed((count) => count + 1);
      setPathHistory((prev) => [...prev, animePathStep(media, viaLabel, viaCharacters)]);
      setCurrent({ kind: 'anime', mediaId: media.id });
      if (reachedGoal) {
        setPhase('won');
      }
    },
    [goalMedia],
  );

  // Staff → anime voice hops: the filmography row has the character *names*
  // but not their ids, so resolve the VA group at the target media to capture
  // character ids for the arrow's middle-click. Falls back to a plain hop if
  // the lookup misses or the row is a production credit.
  const onHopToAnimeFromFilmography = useCallback(
    async (row: AnimeFilmographyRow) => {
      const viaLabel = viaLabelFromFilmography(row);
      let viaCharacters: PathHopCharacter[] | undefined;
      if (row.creditKind === 'voice' && current?.kind === 'staff') {
        const staffId = current.staffId;
        try {
          const vaRows = await getVaCreditsAtMedia(importCtx.current.db, row.media.id);
          const group = groupSortedVaCredits(vaRows).find((g) => g.staff.id === staffId);
          if (group) {
            viaCharacters = charactersFromVaGroup(group);
          }
        } catch {
          // Best-effort: still hop without the character link on lookup failure.
        }
      }
      onHopToAnime(row.media, viaLabel, viaCharacters);
    },
    [current, onHopToAnime],
  );

  const endpointsSwapDisabled = !startMedia || !goalMedia;

  const apiWaitBanner =
    apiWait &&
    apiWaitSecondsLeft !== null && (
      <div className="app-banner warn">
        <span>
          AniList rate limit — retrying in {apiWaitSecondsLeft}s (attempt {apiWait.attempt})
        </span>
      </div>
    );

  return (
    <div className="app-shell">
      {exitRoundConfirmOpen && (
        <ExitRoundConfirmModal
          onConfirm={onExitRoundConfirm}
          onCancel={onExitRoundCancel}
        />
      )}
      {giveUpConfirmOpen && (
        <GiveUpConfirmModal onConfirm={onGiveUpConfirm} onCancel={onGiveUpCancel} />
      )}
      <AppBannerStack>
        {(opfsLockContendedByOtherTab || (ready && storageMode === 'memory')) && (
          <div className="app-banner warn">
            <span>
              {describeNonPersistentStorageBanner({
                reason: opfsLockContendedByOtherTab ? 'other_tab' : 'opfs_unavailable',
                storageHint: storageHint ?? undefined,
                context: 'a2a',
              })}
            </span>
          </div>
        )}
        {apiWaitBanner}
      </AppBannerStack>
      <AnimeToAnimeHeader
        theme={theme}
        vaListImageMode={vaListImageMode}
        roundConfig={roundConfig}
        dbSync={dbSync}
        onToggleTheme={onToggleTheme}
        onVaListImageModeChange={onVaListImageModeChange}
        staffGenderFilter={genderFilter}
        onStaffGenderFilterChange={onGenderFilterChange}
        onRoundConfigChange={onRoundConfigChange}
        historyBackGuard={historyBackGuard}
        onToggleHistoryBackGuard={onToggleHistoryBackGuard}
        titleInteractive={phase !== 'setup'}
        onTitleClick={confirmExitToSetup}
      />

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

          <div className="anime-to-anime-primary-action">
            <button type="button" className="btn primary" onClick={beginRound}>
              Start round
            </button>
          </div>
        </main>
      ) : (
        <main className="page anime-to-anime-page">
          <RoundEndpointsRow
            phase={phase === 'play' ? 'play' : 'won'}
            startMedia={startMedia}
            goalMedia={goalMedia}
            linksUsed={linksUsed}
            swapDisabled={endpointsSwapDisabled}
            onRandomStart={() => void randomizeEndpoint('start')}
            onRandomGoal={() => void randomizeEndpoint('goal')}
            onSwap={swapStartGoal}
          />

          {phase === 'play' && pathHistory.length > 0 && (
            <PathHistoryTrail steps={pathHistory} />
          )}

          {(phase === 'won' || phase === 'gave_up') && startMedia && goalMedia && (
            <WinScreen
              outcome={phase === 'won' ? 'won' : 'gave_up'}
              startMedia={startMedia}
              goalMedia={goalMedia}
              linksUsed={linksUsed}
              pathHistory={pathHistory}
              onBuildCachedPathStream={
                phase === 'won'
                  ? onBuildCachedPathStreamForWin
                  : onBuildCachedPathStreamForGiveUp
              }
              onPlayAgain={onPlayAgain}
              onOpenStep={onOpenPathStep}
              onOpenMedia={onOpenMediaDetail}
            />
          )}

          {error && (
            <p role="alert" className="settings-source-db-error">
              {error}
            </p>
          )}

          {phase === 'play' && (
            <>
              <div className="anime-to-anime-play-toolbar">
                <input
                  type="search"
                  className="slot-search anime-to-anime-search"
                  placeholder="Filter list…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <button type="button" className="btn" onClick={onGiveUpClick}>
                  Give up
                </button>
              </div>

              {loading && <p className="settings-status">Loading…</p>}

              {current?.kind === 'anime' && currentMedia && currentAnimeAnilistLink && (
                <section className="anime-to-anime-play-panel">
                  <h2
                    className={mergeAnilistLinkClass(
                      'anime-to-anime-current-title',
                      currentAnimeAnilistLink.className,
                    )}
                    onMouseDown={currentAnimeAnilistLink.onMouseDown}
                    onAuxClick={currentAnimeAnilistLink.onAuxClick}
                  >
                    {pickMediaTitle(currentMedia)}
                  </h2>
                  {activeRoundConfig?.allowRelations && (
                    <>
                      <h3 className="anime-to-anime-subheading">Related anime</h3>
                      <ul className="anilist-detail-cast-list">
                        {filteredRelations.map((row) => {
                          const relationLink = bindAnilistMiddleClick(anilistUrlForMedia(row.media));
                          return (
                          <li key={`${row.media.id}-${row.relationType}`} className="anilist-detail-cast-item">
                            <button
                              type="button"
                              className={mergeAnilistLinkClass(
                                'btn link anime-to-anime-hop-btn',
                                relationLink.className,
                              )}
                              onClick={() => onHopToAnime(row.media, viaLabelFromRelation(row.relationType))}
                              onMouseDown={relationLink.onMouseDown}
                              onAuxClick={relationLink.onAuxClick}
                            >
                              {pickMediaTitle(row.media)}
                              <span className="anime-to-anime-hop-meta">{row.relationType}</span>
                            </button>
                          </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                  <PlayListSectionHeader
                    title={playListTitleWithStaffGenderFilter(
                      'Voice actors',
                      genderFilter,
                    )}
                    titleHint={staffGenderFilterListHint(genderFilter)}
                    onRefresh={onRefreshPlayList}
                    refreshing={loading}
                    refreshLabel="Refresh cast from AniList"
                    stale={currentCastStaleFetchedAt !== null}
                    staleRefreshLabel={
                      currentCastStaleFetchedAt !== null
                        ? graphStaleRefreshTooltip(
                            currentCastStaleFetchedAt,
                            "This entry's cached cast",
                            'refresh',
                          )
                        : undefined
                    }
                  />
                  <ul className="anime-to-anime-hop-list">
                    {filteredVa.map((group: GroupedVaCreditRow) => (
                      <li
                        key={group.staff.id}
                        className="anime-to-anime-hop-list-item"
                      >
                        <VaCreditHopButton
                          group={group}
                          vaListImageMode={vaListImageMode}
                          onHop={() =>
                            onHopToStaff(
                              group.staff,
                              viaLabelFromVaGroup(group),
                              charactersFromVaGroup(group),
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                  {roundConfig.allowProduction && (
                    <>
                      <h3
                        className="anime-to-anime-subheading anime-to-anime-list-header-title"
                        title={staffGenderFilterListHint(genderFilter)}
                      >
                        {playListTitleWithStaffGenderFilter(
                          'Production staff',
                          genderFilter,
                        )}
                      </h3>
                      <ul className="anime-to-anime-hop-list">
                        {filteredProd.map((row) => (
                          <li
                            key={row.staff.id}
                            className="anime-to-anime-hop-list-item"
                          >
                            <ProductionCreditHopButton
                              row={row}
                              onHop={() => onHopToStaff(row.staff, viaLabelFromProduction(row))}
                            />
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}

              {current?.kind === 'staff' && staffHeader && (
                <section className="anime-to-anime-play-panel">
                  <StaffFilmographySections
                    staffId={staffHeader.id}
                    staffName={pickPersonName(staffHeader, undefined, 'Staff')}
                    rows={filteredFilmography}
                    loading={loading}
                    stale={isGraphTimestampStale(staffFilmographyFetchedAt)}
                    fetchedAt={staffFilmographyFetchedAt}
                    onRefresh={onRefreshPlayList}
                    onHopToAnime={(row) => {
                      void onHopToAnimeFromFilmography(row);
                    }}
                    showMyListFilter={listUserId !== null && filmography.length > 0}
                    onlyMyList={onlyMyList}
                    onOnlyMyListChange={setOnlyMyList}
                    myListEmpty={filmography.length > 0 && myListMediaIds.size === 0}
                  />
                </section>
              )}
            </>
          )}
        </main>
      )}

      {itemDetailTarget && (
        <AnilistDetailModal
          mediaId={itemDetailTarget.mediaId}
          fallbackTitle={itemDetailTarget.fallbackTitle}
          onClose={() => setItemDetailTarget(null)}
          onOpenStaff={(staffId, fallbackName) => {
            setItemDetailTarget(null);
            setStaffDetailTarget({ staffId, fallbackName });
          }}
        />
      )}
      {staffDetailTarget && (
        <StaffDetailModal
          staffId={staffDetailTarget.staffId}
          fallbackName={staffDetailTarget.fallbackName}
          onClose={() => setStaffDetailTarget(null)}
          onOpenMedia={(mediaId, fallbackTitle) => {
            setStaffDetailTarget(null);
            setItemDetailTarget({ mediaId, fallbackTitle });
          }}
        />
      )}
    </div>
  );
}
