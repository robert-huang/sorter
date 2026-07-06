import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FavouritesFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import type { ToolPanelProps } from '../toolTypes';
import { ToolClearableInput } from '../ToolClearableInput';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { CharacterNameInlineList, ToolCharacterName, ToolShowButton, ToolStaffButton } from '../toolEntityLinks';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { runFavouritesAnalysis, type FavouritesRunProgress } from './favouritesApi';
import {
  BIRTHDAY_MONTH_LABELS,
  buildBirthdayCalendarLayout,
  buildBirthdayCalendarRenderItems,
  buildVaPercentRankRows,
  FAVOURITES_TOP_N,
  rebuildFavouritesResult,
  filterFavouritesSeriesRows,
  type FavouriteCharacterRef,
  type FavouritesForm,
  type FavouritesRebuildSource,
  type FavouritesResult,
  type FavouritesSeriesRow,
  type VaPercentRoleMode,
  type VaRankRow,
} from './favouritesLogic';

const LS_KEY = 'anime-tools-favourites-form';

const EXPAND_ROLES_TITLE =
  'Fully re-fetch role data from AniList and save to the local database — every favourite character’s appearances, then voice-actor roles for VAs found on those characters, then voice-actor roles for your favourite staff. Can take a long time for large favourite lists. Use Analyze for a faster run from cache.';

const VA_BAYESIAN_RANK_HELP =
  'Bayesian average of your favourite-list ranks for characters this VA voices. N = total favourites, n = favourites for a given VA, r = rank of the character (1 = top). Character Count per VA = (N÷10+1)+n, Rank-Sum per VA = (N÷2×N÷10)+∑r, Bayesian Score = Count + Rank-Sum — lower is better (more top-ranked favourites).';

const VA_LOG_SCORE_HELP =
  'Log score favours VAs behind higher-ranked favourites. N = total favourites, r = rank of the character (1 = top). Per matched character, add ln(N) − ln(r) (same as ln(N÷r); rank 1 adds the most). Shown value is the total × 10 — higher is better.';

const DEFAULT_FORM: FavouritesForm = {
  username: '',
};

function loadForm(): FavouritesForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
    }
    const parsed = JSON.parse(raw) as Partial<FavouritesForm & { useEnglishNames?: boolean }>;
    return {
      ...DEFAULT_FORM,
      username: withLastAnilistUsername(parsed.username ?? ''),
    };
  } catch {
    return { ...DEFAULT_FORM, username: withLastAnilistUsername('') };
  }
}

function saveForm(form: FavouritesForm): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(form));
  } catch {
    /* ignore */
  }
}

function progressLabel(progress: FavouritesRunProgress | null): string | null {
  if (!progress) {
    return null;
  }
  switch (progress.phase) {
    case 'list':
      return 'Loading user list…';
    case 'characters':
      return 'Loading favourite characters and staff…';
    case 'character-vas':
      return `Fetching VAs for ${progress.name} (${progress.index}/${progress.total})…`;
    case 'va-totals':
      return `Counting VA filmography (${progress.index}/${progress.total})…`;
    case 'expand-staff-filmography':
      return `Expanding staff filmography (${progress.index}/${progress.total})…`;
    case 'build':
      return 'Building report…';
    default:
      return null;
  }
}

function VaRankList({
  rows,
  title,
  onOpenStaff,
}: {
  rows: VaRankRow[];
  title: string;
  onOpenStaff: ToolPanelProps['onOpenStaff'];
}) {
  const [visible, setVisible] = useState(FAVOURITES_TOP_N);
  const shown = rows.slice(0, visible);
  const hasMore = visible < rows.length;

  return (
    <>
      <ul className="tool-rank-list">
        {shown.map((row) => (
          <li key={`${title}-${row.staffId}`}>
            <span className="tool-rank-count">{row.displayValue}</span>
            <ToolStaffButton
              staffId={row.staffId}
              name={row.name}
              imageUrl={row.imageUrl}
              onOpenStaff={onOpenStaff}
              compact
            />
            <span className="tool-rank-detail">
              <CharacterNameInlineList characters={row.characters} />
            </span>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <button
          type="button"
          className="btn"
          onClick={() => setVisible((current) => current + FAVOURITES_TOP_N)}
        >
          Load more
        </button>
      ) : null}
    </>
  );
}

function VaRankBlock({
  title,
  rows,
  onOpenStaff,
  defaultOpen = false,
  titleHelp,
}: {
  title: string;
  rows: VaRankRow[];
  onOpenStaff: ToolPanelProps['onOpenStaff'];
  defaultOpen?: boolean;
  titleHelp?: string;
}) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <details className="tool-category-block" open={defaultOpen || undefined}>
      <summary className="tool-category-title" title={titleHelp}>
        {title}
      </summary>
      <VaRankList rows={rows} title={title} onOpenStaff={onOpenStaff} />
    </details>
  );
}

function VaPercentBlock({
  byCount,
  vaPercentMeta,
  onOpenStaff,
}: {
  byCount: VaRankRow[];
  vaPercentMeta: FavouritesResult['vaPercentMeta'];
  onOpenStaff: ToolPanelProps['onOpenStaff'];
}) {
  const [roleMode, setRoleMode] = useState<VaPercentRoleMode>('all');
  const rows = useMemo(
    () => buildVaPercentRankRows(byCount, vaPercentMeta, roleMode),
    [byCount, vaPercentMeta, roleMode],
  );

  if (byCount.length === 0) {
    return null;
  }

  return (
    <details className="tool-category-block">
      <summary className="tool-category-title">
        Top VAs by % of their characters favourited
      </summary>
      <div className="favourites-percent-role-toggle">
        <label>
          <input
            type="radio"
            name="favourites-percent-role-mode"
            checked={roleMode === 'all'}
            onChange={() => setRoleMode('all')}
          />{' '}
          All Roles
        </label>
        <label>
          <input
            type="radio"
            name="favourites-percent-role-mode"
            checked={roleMode === 'mainOnly'}
            onChange={() => setRoleMode('mainOnly')}
          />{' '}
          Main Roles Only
        </label>
      </div>
      <VaRankList
        rows={rows}
        title="Top VAs by % of their characters favourited"
        onOpenStaff={onOpenStaff}
      />
    </details>
  );
}

function SeriesListBlock({
  title,
  rows,
  onOpenMedia,
}: {
  title: string;
  rows: FavouritesSeriesRow[];
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const [search, setSearch] = useState('');
  const filteredRows = useMemo(() => filterFavouritesSeriesRows(rows, search), [rows, search]);

  if (rows.length === 0) {
    return null;
  }
  return (
    <details className="tool-category-block">
      <summary className="tool-category-title">{title}</summary>
      <div className="favourites-series-search">
        <ToolClearableInput
          id={`${title}-search`}
          value={search}
          placeholder="Filter series or characters…"
          onChange={setSearch}
        />
      </div>
      {filteredRows.length === 0 ? (
        <p className="tool-status">No matches.</p>
      ) : (
        filteredRows.map((row) => (
          <div key={row.mediaId} className="tool-series-row">
            <ToolShowButton
              mediaId={row.mediaId}
              title={row.title}
              coverImage={row.coverImage}
              mediaType={row.mediaType}
              onOpenMedia={onOpenMedia}
              compact
            />
            <span className="tool-rank-detail">
              <CharacterNameInlineList characters={row.characters} />
            </span>
          </div>
        ))
      )}
    </details>
  );
}

function BirthdayCalendarBlock({
  birthdays,
}: {
  birthdays: FavouritesResult['birthdays'];
}) {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const layout = useMemo(() => buildBirthdayCalendarLayout(birthdays), [birthdays]);
  const calendarItems = useMemo(
    () => buildBirthdayCalendarRenderItems(layout),
    [layout],
  );
  const hasBirthdays =
    layout.cells.some((cell) => cell.characters.length > 0) || layout.incomplete.length > 0;

  if (!hasBirthdays) {
    return null;
  }

  return (
    <details className="tool-category-block">
      <summary className="tool-category-title">Birthdays</summary>
      <div className="favourites-percent-role-toggle">
        <label>
          <input
            type="radio"
            name="favourites-birthday-view-mode"
            checked={viewMode === 'list'}
            onChange={() => setViewMode('list')}
          />{' '}
          List
        </label>
        <label>
          <input
            type="radio"
            name="favourites-birthday-view-mode"
            checked={viewMode === 'grid'}
            onChange={() => setViewMode('grid')}
          />{' '}
          Calendar
        </label>
      </div>
      {viewMode === 'list' ? (
        <ul className="tool-rank-list">
          {Object.entries(birthdays)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, characters]) => (
              <li key={day}>
                <span className="tool-rank-count">{day}</span>
                <CharacterNameInlineList characters={characters} />
              </li>
            ))}
        </ul>
      ) : (
        <>
          <div className="favourites-birthday-calendar">
            {calendarItems.map((item) => {
              if (item.kind === 'pad') {
                return (
                  <div
                    key={`pad-${item.afterMonth}-${item.padKind}-${item.slotIndex}`}
                    className="favourites-birthday-month-pad"
                    aria-hidden
                  />
                );
              }
              if (item.kind === 'monthBreak') {
                return (
                  <div
                    key={`break-${item.afterMonth}`}
                    className="favourites-birthday-month-break"
                    aria-hidden
                  />
                );
              }
              const { cell } = item;
              const isMonthStart = cell.day === 1;
              const hasCharacters = cell.characters.length > 0;
              return (
                <div
                  key={`${cell.month}-${cell.day}`}
                  className={[
                    'favourites-birthday-cell',
                    hasCharacters ? 'favourites-birthday-cell--filled' : '',
                    isMonthStart ? 'favourites-birthday-cell--month-start' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {isMonthStart ? (
                    <span className="favourites-birthday-month">
                      {BIRTHDAY_MONTH_LABELS[cell.month - 1]}
                    </span>
                  ) : null}
                  <span className="favourites-birthday-day">{cell.day}</span>
                  {hasCharacters ? (
                    <div className="favourites-birthday-names">
                      {cell.characters.map((character) => (
                        <div key={character.id} className="favourites-birthday-name-line">
                          <ToolCharacterName
                            characterId={character.id}
                            name={character.name}
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {layout.incomplete.length > 0 ? (
            <div className="favourites-birthday-incomplete">
              <span className="favourites-birthday-incomplete-label">Unknown date</span>
              <CharacterNameInlineList characters={layout.incomplete} />
            </div>
          ) : null}
        </>
      )}
    </details>
  );
}

function NameListBlock({
  title,
  characters,
}: {
  title: string;
  characters: FavouriteCharacterRef[];
}) {
  if (characters.length === 0) {
    return null;
  }
  return (
    <details className="tool-category-block">
      <summary className="tool-category-title">
        {title} ({characters.length})
      </summary>
      <p className="tool-name-list">
        <CharacterNameInlineList characters={characters} />
      </p>
    </details>
  );
}

function GroupedCategoryBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="tool-category-block">
      <summary className="tool-category-title">{title}</summary>
      {children}
    </details>
  );
}

function FavouriteCharactersBlock({
  characters,
}: {
  characters: FavouritesResult['favouriteCharacters'];
}) {
  if (characters.length === 0) {
    return null;
  }
  return (
    <details className="tool-category-block">
      <summary className="tool-category-title">
        Favourite characters ({characters.length})
      </summary>
      <ol className="tool-rank-list tool-favourite-characters-list">
        {characters.map((character) => (
          <li key={character.id}>
            <span className="tool-rank-count">{character.rank}.</span>
          <ToolCharacterName
            characterId={character.id}
            name={character.name}
            gender={character.gender}
          />
          </li>
        ))}
      </ol>
    </details>
  );
}

export function FavouritesPanel({ onOpenMedia, onOpenStaff }: ToolPanelProps) {
  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    refreshFavourites: true,
    // Characters by manga series + VA main-role totals need consumed manga ids.
    refreshManga: true,
  });
  const displayLabelRevision = useToolsDisplayLabelRevision();
  const [form, setForm] = useState<FavouritesForm>(() => loadForm());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<FavouritesRunProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FavouritesResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rebuildSourceRef = useRef<FavouritesRebuildSource | null>(null);

  useEffect(() => {
    saveForm(form);
  }, [form]);

  useEffect(() => {
    const source = rebuildSourceRef.current;
    if (!source) {
      return;
    }
    setResult(rebuildFavouritesResult(source));
  }, [displayLabelRevision]);

  const patchForm = useCallback((patch: Partial<FavouritesForm>) => {
    setError(null);
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setProgress(null);
  }, []);

  const runAnalysis = useCallback(
    async (fetchOptions?: FavouritesFetchOptions) => {
      const username = form.username.trim();
      if (!username) {
        setError('Enter an AniList username.');
        setResult(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setRunning(true);
      setError(null);
      setResult(null);
      rebuildSourceRef.current = null;
      setProgress({ phase: 'list' });

      try {
        const { result: report, rebuildSource } = await runFavouritesAnalysis(
          form,
          setProgress,
          controller.signal,
          fetchOptions,
        );
        rebuildSourceRef.current = rebuildSource;
        setResult(report);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          return;
        }
        setError(e instanceof Error ? e.message : 'Failed to run analysis.');
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
          setProgress(null);
        }
      }
    },
    [form],
  );

  const onRun = useCallback(
    (forceRefreshFavourites = false) => {
      void runAnalysis(
        forceRefreshFavourites ? { forceRefreshFavourites: true } : undefined,
      );
    },
    [runAnalysis],
  );

  const onExpandRoles = useCallback(() => {
    void runAnalysis({ expandRoles: true });
  }, [runAnalysis]);

  const statusText = progressLabel(progress);
  const mainRolePct =
    result && result.numSeen > 0
      ? Math.round((result.numMain / result.numSeen) * 100)
      : null;
  const femalePct =
    result && result.numSeen > 0
      ? Math.round((result.numFemaleSeen / result.numSeen) * 100)
      : null;

  return (
    <section className="tool-panel">
      <p className="tool-panel-lead">
        Find voice actors behind your favourite characters — port of{' '}
        <code>character_vas.py</code>.
        <br />
        <strong>Analyze</strong> uses cached favourites and local database lookups for a
        fast run; use ↻ to force-refresh your anime + manga lists and favourites from
        AniList.
        <br />
        <strong>Expand Roles</strong> fully re-fetches character and VA role data into the
        local database (can take a long time).
        <br />
        Gear → Settings controls display names.
      </p>

      <form
        className="tool-form-card"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) {
            onRun(false);
          }
        }}
      >
        <ToolUsernameField
          label="AniList username"
          value={form.username}
          disabled={running}
          refreshing={refreshingList}
          refreshLabel="Refresh list and favourites from AniList"
          onChange={(username) => patchForm({ username })}
          onRefresh={() => refreshUsernameList(form.username, running)}
        />

        <div className="tool-actions">
          <ToolRunButton
            label="Analyze"
            running={running}
            forceRefreshTitle="Right-click to re-fetch favourite characters and staff from AniList"
            onRun={(forceRefresh) => onRun(forceRefresh)}
          />
          <button
            type="button"
            className="btn danger"
            disabled={running}
            title={running ? undefined : EXPAND_ROLES_TITLE}
            onClick={onExpandRoles}
          >
            Expand Roles
          </button>
          {running && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>

        {statusText && <p className="tool-status">{statusText}</p>}
        {error && <p className="tool-error">{error}</p>}
      </form>

      {result && (
        <div className="tool-results favourites-results">
          <p className="tool-summary">
            {result.characterCount} favourite characters · {result.vaCount} VAs ·{' '}
            {result.numSeen} seen on your list
            {mainRolePct !== null ? (
              <>
                {' · '}
                <span title={`${result.numMain}/${result.numSeen}`}>
                  ~{mainRolePct}% main roles
                </span>
              </>
            ) : null}
            {femalePct !== null ? (
              <>
                {' · '}
                <span title={`${result.numFemaleSeen}/${result.numSeen}`}>
                  ~{femalePct}% female
                </span>
              </>
            ) : null}
          </p>

          <VaRankBlock
            title="Top VAs by favourite character count"
            rows={result.byCount}
            onOpenStaff={onOpenStaff}
            defaultOpen
          />
          <VaRankBlock
            title="Top VAs by average favourite rank (Bayesian)"
            rows={result.byAvgRank}
            onOpenStaff={onOpenStaff}
            titleHelp={VA_BAYESIAN_RANK_HELP}
          />
          <VaRankBlock
            title="Top VAs by log score"
            rows={result.byLogScore}
            onOpenStaff={onOpenStaff}
            titleHelp={VA_LOG_SCORE_HELP}
          />
          <VaPercentBlock
            byCount={result.byCount}
            vaPercentMeta={result.vaPercentMeta}
            onOpenStaff={onOpenStaff}
          />

          <FavouriteCharactersBlock characters={result.favouriteCharacters} />

          <GroupedCategoryBlock title="Gender">
            <NameListBlock title="Female characters" characters={result.gender.female} />
            <NameListBlock title="Male characters" characters={result.gender.male} />
            <NameListBlock title="Other / unknown gender" characters={result.gender.other} />
          </GroupedCategoryBlock>

          <GroupedCategoryBlock title="Roles">
            <NameListBlock title="Main roles" characters={result.roles.main} />
            <NameListBlock title="Supporting roles" characters={result.roles.supporting} />
            <NameListBlock title="Background roles" characters={result.roles.background} />
            <NameListBlock title="Unknown roles (or manga only)" characters={result.roles.unknown} />
          </GroupedCategoryBlock>

          <BirthdayCalendarBlock birthdays={result.birthdays} />

          <details className="tool-category-block">
            <summary className="tool-category-title">Favourite staff (VAs)</summary>
            <ul className="tool-rank-list">
              {result.favouriteStaff.map((staff) => (
                <li key={staff.id}>
                  <span className="tool-rank-count">{staff.matchedCount}</span>
                  <ToolStaffButton
                    staffId={staff.id}
                    name={staff.name}
                    imageUrl={staff.imageUrl}
                    gender={staff.gender}
                    onOpenStaff={onOpenStaff}
                    compact
                  />
                  {staff.matchedCharacters.length > 0 ? (
                    <span className="tool-rank-detail">
                      <CharacterNameInlineList characters={staff.matchedCharacters} />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>

          <SeriesListBlock
            title="Characters by anime series"
            rows={result.seriesAnime}
            onOpenMedia={onOpenMedia}
          />

          <SeriesListBlock
            title="Characters by manga series"
            rows={result.seriesManga}
            onOpenMedia={onOpenMedia}
          />
        </div>
      )}
    </section>
  );
}
