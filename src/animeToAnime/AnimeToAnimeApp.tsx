import { useCallback, useEffect, useMemo, useState } from 'react';
import * as client from '../lib/db/client';
import { ANILIST_SOURCE_ID } from '../lib/importers/anilist/anilistSource';
import { makeAnilistImportContext } from '../lib/importers/anilist/context';
import { ensureMediaCastExpanded, ensureStaffFilmography } from '../lib/importers/anilist/ensureGraph';
import {
  getAnimeFilmographyForStaff,
  getProductionCreditsAtMedia,
  getVaCreditsAtMedia,
  pickRandomAnimeFromCache,
  type AnimeFilmographyRow,
  type ProductionCreditRow,
  type VaCreditRow,
} from '../lib/importers/anilist/graphQueries';
import { productionReads } from '../lib/importers/anilist/readQueries';
import type { MediaRow, StaffRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';

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
    allowProduction: false,
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
      allowProduction: parsed.allowProduction === true,
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

function defaultDb() {
  return makeAnilistImportContext().db;
}

export function AnimeToAnimeApp() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startMedia, setStartMedia] = useState<MediaRow | null>(null);
  const [goalMedia, setGoalMedia] = useState<MediaRow | null>(null);
  const [roundConfig, setRoundConfig] = useState<RoundConfig>(loadRoundConfig);
  const [phase, setPhase] = useState<'setup' | 'play'>('setup');
  const [current, setCurrent] = useState<Node | null>(null);
  const [animeHops, setAnimeHops] = useState(0);
  const [, setVisitedAnime] = useState<Set<number>>(() => new Set());
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  const [vaCredits, setVaCredits] = useState<VaCreditRow[]>([]);
  const [productionCredits, setProductionCredits] = useState<ProductionCreditRow[]>([]);
  const [filmography, setFilmography] = useState<AnimeFilmographyRow[]>([]);
  const [staffHeader, setStaffHeader] = useState<StaffRow | null>(null);
  const [currentMedia, setCurrentMedia] = useState<MediaRow | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        await client.openSourceDb(ANILIST_SOURCE_ID);
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

  const randomizeEndpoint = useCallback(async (which: 'start' | 'goal') => {
    const row = await pickRandomAnimeFromCache(defaultDb());
    if (!row) {
      setError('No anime in cache match filters. Import lists or broaden filters.');
      return;
    }
    if (which === 'start') {
      setStartMedia(row);
    } else {
      setGoalMedia(row);
    }
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
    setCurrent({ kind: 'anime', mediaId: startMedia.id });
    setAnimeHops(0);
    setVisitedAnime(new Set([startMedia.id]));
  }, [startMedia, goalMedia]);

  const swapStartGoal = useCallback(() => {
    setStartMedia(goalMedia);
    setGoalMedia(startMedia);
  }, [startMedia, goalMedia]);

  useEffect(() => {
    if (phase !== 'play' || !current) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const ctx = makeAnilistImportContext();
      try {
        if (current.kind === 'anime') {
          await ensureMediaCastExpanded(ctx, current.mediaId);
          const mediaRows = await productionReads.getMediaByIds([current.mediaId]);
          const va = await getVaCreditsAtMedia(ctx.db, current.mediaId);
          const prod = roundConfig.allowProduction
            ? await getProductionCreditsAtMedia(
                ctx.db,
                current.mediaId,
                roundConfig.productionAllRoles ? 'all' : 'key',
              )
            : [];
          if (cancelled) return;
          setCurrentMedia(mediaRows[0] ?? null);
          setVaCredits(va);
          setProductionCredits(prod);
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
  }, [current, phase, roundConfig.allowProduction, roundConfig.productionAllRoles]);

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

  const filteredFilmography = useMemo(() => {
    if (!filterLower) return filmography;
    return filmography.filter((row) => {
      const label = pickMediaTitle(row.media);
      return label.toLowerCase().includes(filterLower) || row.role.toLowerCase().includes(filterLower);
    });
  }, [filmography, filterLower]);

  const onHopToStaff = useCallback((staffId: number) => {
    setCurrent({ kind: 'staff', staffId });
  }, []);

  const onHopToAnime = useCallback(
    (mediaId: number) => {
      if (goalMedia && mediaId === goalMedia.id) {
        setError(null);
        setCurrent({ kind: 'anime', mediaId });
        return;
      }
      setVisitedAnime((prev) => {
        const next = new Set(prev);
        if (!next.has(mediaId)) {
          next.add(mediaId);
          setAnimeHops((h) => h + 1);
        }
        return next;
      });
      setCurrent({ kind: 'anime', mediaId });
    },
    [goalMedia],
  );

  if (!ready) {
    return <p style={{ padding: 16 }}>{error ?? 'Opening database…'}</p>;
  }

  if (phase === 'setup') {
    return (
      <div style={{ padding: 16, maxWidth: 640 }}>
        <h1>Anime to Anime</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Connect start → goal through voice actors and optional production staff.
        </p>
        {error && <p role="alert" className="settings-source-db-error">{error}</p>}

        <section style={{ marginTop: 16 }}>
          <h2>Start</h2>
          <p>{startMedia ? pickMediaTitle(startMedia) : '—'}</p>
          <button type="button" className="btn small" onClick={() => void randomizeEndpoint('start')}>
            Random from cache
          </button>
        </section>

        <section style={{ marginTop: 16 }}>
          <h2>Goal</h2>
          <p>{goalMedia ? pickMediaTitle(goalMedia) : '—'}</p>
          <button type="button" className="btn small" onClick={() => void randomizeEndpoint('goal')}>
            Random from cache
          </button>
          <button type="button" className="btn small" onClick={swapStartGoal} disabled={!startMedia || !goalMedia}>
            Swap
          </button>
        </section>

        <section style={{ marginTop: 16 }}>
          <h2>Round options</h2>
          <label>
            <input
              type="checkbox"
              checked={roundConfig.allowProduction}
              onChange={(e) => onRoundConfigChange({ allowProduction: e.target.checked })}
            />{' '}
            Production credits (off by default)
          </label>
          <br />
          <label>
            <input
              type="checkbox"
              checked={roundConfig.productionAllRoles}
              onChange={(e) => onRoundConfigChange({ productionAllRoles: e.target.checked })}
            />{' '}
            All production roles (advanced)
          </label>
          <br />
          <label>
            <input
              type="checkbox"
              checked={roundConfig.allowRelations}
              onChange={(e) => onRoundConfigChange({ allowRelations: e.target.checked })}
            />{' '}
            Franchise relations mode (stub — expand on play)
          </label>
        </section>

        <button type="button" className="btn" style={{ marginTop: 16 }} onClick={beginRound}>
          Start round
        </button>
      </div>
    );
  }

  const goalReached = goalMedia && current?.kind === 'anime' && current.mediaId === goalMedia.id;

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <header style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Start: {startMedia ? pickMediaTitle(startMedia) : '—'} · Goal:{' '}
          {goalMedia ? pickMediaTitle(goalMedia) : '—'}
        </div>
        <div>
          Anime hops: {animeHops}
          {goalReached && (
            <strong style={{ marginLeft: 8, color: 'var(--accent, #16a34a)' }}>
              Goal reached!
            </strong>
          )}
        </div>
        <button type="button" className="btn small" onClick={swapStartGoal}>
          Swap start ↔ goal
        </button>
        <button type="button" className="btn small" onClick={() => setPhase('setup')}>
          Setup
        </button>
      </header>

      {error && <p role="alert" className="settings-source-db-error">{error}</p>}

      <input
        type="search"
        placeholder="Filter list…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ width: '100%', marginBottom: 12 }}
      />

      {loading && <p>Loading…</p>}

      {current?.kind === 'anime' && currentMedia && (
        <>
          <h2>{pickMediaTitle(currentMedia)}</h2>
          <h3>Voice actors</h3>
          <ul className="anilist-detail-cast-list">
            {filteredVa.map((row) => (
              <li key={`${row.staff.id}-${row.character.id}`} className="anilist-detail-cast-item">
                <button
                  type="button"
                  className="btn link"
                  style={{ textAlign: 'left', width: '100%' }}
                  onClick={() => onHopToStaff(row.staff.id)}
                >
                  <strong>{row.staff.name_full ?? row.staff.name_native}</strong>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>
                    as {row.character.name_full ?? row.character.name_native}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {roundConfig.allowProduction && (
            <>
              <h3>Production</h3>
              <ul className="anilist-detail-cast-list">
                {filteredProd.map((row) => (
                  <li key={`${row.staff.id}-${row.role}`} className="anilist-detail-cast-item">
                    <button
                      type="button"
                      className="btn link"
                      onClick={() => onHopToStaff(row.staff.id)}
                    >
                      {row.staff.name_full ?? row.staff.name_native} — {row.role}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {current?.kind === 'staff' && staffHeader && (
        <>
          <h2>{staffHeader.name_full ?? staffHeader.name_native}</h2>
          <h3>Filmography (anime)</h3>
          <ul className="anilist-detail-cast-list">
            {filteredFilmography.map((row) => (
              <li key={`${row.media.id}-${row.role}`} className="anilist-detail-cast-item">
                <button
                  type="button"
                  className="btn link"
                  onClick={() => onHopToAnime(row.media.id)}
                >
                  {pickMediaTitle(row.media)}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>
                    {row.role}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
