import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FavouritesFetchOptions } from '../../lib/importers/anilist/toolsFetchPolicy';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { CharacterNameInlineList, ToolCharacterName, ToolShowButton, ToolStaffButton } from '../toolEntityLinks';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { runFavouritesAnalysis, type FavouritesRunProgress } from './favouritesApi';
import {
  FAVOURITES_TOP_N,
  rebuildFavouritesResult,
  type FavouriteCharacterRef,
  type FavouritesForm,
  type FavouritesRebuildSource,
  type FavouritesResult,
  type FavouritesSeriesRow,
  type VaRankRow,
} from './favouritesLogic';

const LS_KEY = 'anime-tools-favourites-form';

const EXPAND_ROLES_TITLE =
  'Fully re-fetch role data from AniList and save to the local database — every favourite character’s appearances, then voice-actor roles for VAs found on those characters, then voice-actor roles for your favourite staff. Can take a long time for large favourite lists. Use Analyze for a faster run from cache.';

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

function VaRankBlock({
  title,
  rows,
  onOpenStaff,
  defaultOpen = false,
}: {
  title: string;
  rows: VaRankRow[];
  onOpenStaff: ToolPanelProps['onOpenStaff'];
  defaultOpen?: boolean;
}) {
  const [visible, setVisible] = useState(FAVOURITES_TOP_N);

  if (rows.length === 0) {
    return null;
  }

  const shown = rows.slice(0, visible);
  const hasMore = visible < rows.length;

  return (
    <details className="tool-category-block" open={defaultOpen || undefined}>
      <summary className="tool-category-title">{title}</summary>
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
  if (rows.length === 0) {
    return null;
  }
  return (
    <details className="tool-category-block">
      <summary className="tool-category-title">{title}</summary>
      {rows.map((row) => (
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
      ))}
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
        <code>character_vas.py</code>. <strong>Analyze</strong> uses cached favourites and
        local database lookups for a fast run; use the ↻ button to refresh your anime list
        from AniList. <strong>Expand Roles</strong> fully re-fetches character and VA role
        data into the local database (can take a long time). Gear → Settings controls display
        names.
      </p>

      <form
        className="tool-form-card"
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
            {mainRolePct !== null ? ` · ~${mainRolePct}% main roles` : ''}
            {femalePct !== null ? ` · ~${femalePct}% female` : ''}
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
          />
          <VaRankBlock
            title="Top VAs by log score"
            rows={result.byLogScore}
            onOpenStaff={onOpenStaff}
          />
          <VaRankBlock
            title="Top VAs by % of their characters favourited"
            rows={result.byPercent}
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

          <details className="tool-category-block">
            <summary className="tool-category-title">Birthdays</summary>
            <ul className="tool-rank-list">
              {Object.entries(result.birthdays)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([day, characters]) => (
                  <li key={day}>
                    <span className="tool-rank-count">{day}</span>
                    <CharacterNameInlineList characters={characters} />
                  </li>
                ))}
            </ul>
          </details>

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
