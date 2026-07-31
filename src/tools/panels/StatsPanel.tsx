import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { ToolAnimeMangaMediaTypeFilter, ToolSegmentedFilter } from '../ToolSegmentedFilter';
import { useUsernameListRefresh } from '../useUsernameListRefresh';
import { useToolsDisplayLabelRevision } from '../useToolsDisplayLabelRevision';
import { relabelStatsEntries } from '../toolsDisplayRelabel';
import { withLastAnilistUsername } from '../../lib/importers/anilist/lastUsername';
import {
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
  anilistUrlForMediaEntry,
} from '../../lib/importers/anilist/anilistLinks';
import {
  MultiSelectChip,
  ScoreRangeChip,
  TagOptionsChip,
  toggleInArray,
} from '../../lib/importers/anilist/filters';
import { DragScroll } from '../../components/DragScroll';
import { Modal } from '../../components/Modal';
import { useClickOutside } from '../../lib/hooks/useClickOutside';
import {
  ToolCharacterName,
  ToolEntityAvatar,
  ToolShowButton,
  ToolStaffButton,
} from '../toolEntityLinks';
import {
  bustStatsSessionMemo,
  expandStatsCast,
  fetchStatsData,
  statsCachedNeedsCast,
  type StatsFetchProgress,
} from './statsApi';
import {
  availableStatsAggregationTypes,
  buildActiveStatsChartRows,
  buildStatsSummary,
  buildStatsTimeWatchedRows,
  buildStatsTableCsv,
  buildStatsTableJson,
  compareStatsSortValues,
  applyStatsTableSort,
  createDefaultStatsChartSorts,
  cycleStatsParentSort,
  cycleStatsSubrowSort,
  entryEpisodesRemaining,
  entryTimeRemainingMinutes,
  entryChaptersRemaining,
  entryVolumesRemaining,
  filterStatsParentRowsByMinCount,
  filterStatsPool,
  filterStatsPoolByRatingScore,
  DEFAULT_STATS_LIST_STATUS_FILTERS,
  DEFAULT_STATS_MEDIA_STATUS_FILTERS,
  DEFAULT_STATS_TAG_OPTIONS,
  formatStatsDuration,
  formatStatsDurationWithDayCount,
  formatStatsFormatLabel,
  formatStatsMediaStatusLabel,
  formatStatsScoreCell,
  normalizeStatsAggregationType,
  normalizeStatsAnimeFormatFilters,
  normalizeStatsListStatusFilters,
  normalizeStatsMangaFormatFilters,
  normalizeStatsMediaStatusFilters,
  normalizeStatsStaffRoleFilters,
  normalizeStatsStudioKindFilters,
  normalizeStatsTagOptions,
  normalizeStatsVaRoleFilters,
  statsRatedScore,
  statsSubrowHasMainRole,
  statsAggregationEmptyHint,
  statsDefaultStaffRoleFilters,
  statsEffectiveEpisodes,
  statsEntryScoreSortValue,
  STATS_ANIME_FORMAT_OPTIONS,
  STATS_CHARACTER_ROLE_OPTIONS,
  STATS_LIST_STATUS_OPTIONS,
  STATS_MANGA_FORMAT_OPTIONS,
  STATS_MEDIA_STATUS_OPTIONS,
  STATS_STUDIO_KIND_OPTIONS,
  statsAnimeStaffRoleOptions,
  statsMangaStaffRoleOptions,
  statsScoreToneClass,
  type StatsAggregationType,
  type StatsCachedData,
  type StatsBuildResult,
  type StatsEntry,
  type StatsForm,
  type StatsParentRow,
  type StatsSortColumn,
  type StatsSubrow,
  type StatsSubrowLink,
  type StatsSummary,
  type StatsTableChartId,
  type StatsTableSortConfig,
  type StatsTimeWatchedRow,
} from './statsLogic';

const LS_KEY = 'anime-tools-stats-form';
const LS_FILTERS_KEY = 'anime-tools-stats-filters';

const DEFAULT_FORM: StatsForm = {
  username: '',
  mediaType: 'ANIME',
  mediaStatusFilters: [...DEFAULT_STATS_MEDIA_STATUS_FILTERS],
  formatFilters: [...STATS_ANIME_FORMAT_OPTIONS],
  listStatusFilters: [...DEFAULT_STATS_LIST_STATUS_FILTERS],
  userScoreInclude: 'any',
  scoreMin: null,
  scoreMax: null,
  minCount: 0,
  showSummary: false,
  aggregationType: 'VA',
  staffRoleFilters: statsDefaultStaffRoleFilters('ANIME'),
  vaRoleFilters: [...STATS_CHARACTER_ROLE_OPTIONS],
  vaShowMainRoleInfo: false,
  vaShowDiff: false,
  tagOptions: { ...DEFAULT_STATS_TAG_OPTIONS },
  studioKindFilters: [...STATS_STUDIO_KIND_OPTIONS],
};

type PersistedStatsForm = Pick<StatsForm, 'username' | 'mediaType' | 'aggregationType' | 'vaShowMainRoleInfo' | 'vaShowDiff'>;

type PersistedStatsFilters = Pick<
  StatsForm,
  | 'mediaStatusFilters'
  | 'formatFilters'
  | 'listStatusFilters'
  | 'userScoreInclude'
  | 'scoreMin'
  | 'scoreMax'
  | 'minCount'
  | 'staffRoleFilters'
  | 'vaRoleFilters'
  | 'tagOptions'
  | 'studioKindFilters'
>;

function loadForm(): StatsForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const filtersRaw = localStorage.getItem(LS_FILTERS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PersistedStatsForm> & { showSummary?: boolean }) : {};
    const filters = filtersRaw ? (JSON.parse(filtersRaw) as Partial<PersistedStatsFilters>) : {};
    const mediaType = parsed.mediaType === 'MANGA' ? 'MANGA' : 'ANIME';
    const form: StatsForm = {
      ...DEFAULT_FORM,
      username: typeof parsed.username === 'string' ? parsed.username : '',
      mediaType,
      aggregationType: normalizeStatsAggregationType(parsed.aggregationType, mediaType),
      vaShowMainRoleInfo:
        parsed.vaShowMainRoleInfo === true || (parsed as { vaMainOnly?: boolean }).vaMainOnly === true,
      vaShowDiff: parsed.vaShowDiff === true,
      mediaStatusFilters: normalizeStatsMediaStatusFilters(filters.mediaStatusFilters),
      formatFilters:
        mediaType === 'MANGA'
          ? normalizeStatsMangaFormatFilters(filters.formatFilters)
          : normalizeStatsAnimeFormatFilters(filters.formatFilters),
      listStatusFilters: normalizeStatsListStatusFilters(filters.listStatusFilters),
      userScoreInclude:
        filters.userScoreInclude === 'rated' || filters.userScoreInclude === 'unrated'
          ? filters.userScoreInclude
          : 'any',
      scoreMin: typeof filters.scoreMin === 'number' ? filters.scoreMin : null,
      scoreMax: typeof filters.scoreMax === 'number' ? filters.scoreMax : null,
      minCount:
        typeof filters.minCount === 'number' && filters.minCount >= 0
          ? Math.floor(filters.minCount)
          : 0,
      staffRoleFilters: normalizeStatsStaffRoleFilters(filters.staffRoleFilters, mediaType),
      vaRoleFilters: normalizeStatsVaRoleFilters(filters.vaRoleFilters),
      tagOptions: normalizeStatsTagOptions(filters.tagOptions),
      studioKindFilters: normalizeStatsStudioKindFilters(filters.studioKindFilters),
      // Session-only — never restore from localStorage (legacy blobs may still carry showSummary).
      showSummary: false,
    };
    if (raw && 'showSummary' in parsed) {
      saveForm(form);
    }
    return form;
  } catch {
    return { ...DEFAULT_FORM };
  }
}

function saveForm(form: StatsForm): void {
  try {
    const persisted: PersistedStatsForm = {
      username: form.username,
      mediaType: form.mediaType,
      aggregationType: form.aggregationType,
      vaShowMainRoleInfo: form.vaShowMainRoleInfo,
      vaShowDiff: form.vaShowDiff,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(persisted));
    const filters: PersistedStatsFilters = {
      mediaStatusFilters: form.mediaStatusFilters,
      formatFilters: form.formatFilters,
      listStatusFilters: form.listStatusFilters,
      userScoreInclude: form.userScoreInclude,
      scoreMin: form.scoreMin,
      scoreMax: form.scoreMax,
      minCount: form.minCount,
      staffRoleFilters: form.staffRoleFilters,
      vaRoleFilters: form.vaRoleFilters,
      tagOptions: form.tagOptions,
      studioKindFilters: form.studioKindFilters,
    };
    localStorage.setItem(LS_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* ignore */
  }
}

function describeProgress(progress: StatsFetchProgress | null): string | null {
  if (!progress) {
    return null;
  }
  if (progress.phase === 'list') {
    return 'Fetching list…';
  }
  return `Expanding cast (${progress.index}/${progress.total})…`;
}

const AGGREGATION_LABELS: Record<StatsAggregationType, string> = {
  VA: 'Voice Actors',
  STAFF: 'Staff',
  GENRES_TAGS: 'Genres & Tags',
  STUDIOS: 'Studios',
};

const STATS_GLOBAL_DIFFERENCE_TOOLTIP =
  'Average of (your score − AniList mean score) across rated entries with a known global mean. ' +
  'Positive means you rate higher than the community average.';

const STATS_GLOBAL_DEVIATION_TOOLTIP =
  'Root mean square of (your score − AniList mean score) across rated entries with a known global mean. ' +
  'Measures how far your ratings typically diverge from AniList averages.';

const STATS_TIME_WEIGHTED_MEAN_TOOLTIP =
  'Mean score weighted by total length: anime uses episode length × episode count; manga uses chapter count. ' +
  'Longer entries contribute more than shorts.';

const STATS_RATING_ENTROPY_TOOLTIP =
  'Shannon entropy of your score distribution, in bits. Higher values mean ratings spread across more distinct scores; ' +
  'lower values mean they cluster on fewer scores.';

const STATS_EPISODES_REMAINING_TOOLTIP =
  'Episodes left on currently airing or in-progress shows in the filtered pool. Completed shows count as 0.';

const STATS_CHAPTERS_REMAINING_TOOLTIP =
  'Chapters left on currently releasing or in-progress manga in the filtered pool with a known chapter count. ' +
  'Completed entries and manga without a chapter total count as 0.';

function StatsToggleChip({
  label,
  active,
  disabled,
  onToggle,
  title,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
  title?: string;
}): React.ReactElement {
  return (
    <div className={`filter-chip ${active ? 'active' : ''} filter-chip--summary`}>
      <button
        type="button"
        className="filter-chip-button"
        disabled={disabled}
        onClick={onToggle}
        title={title}
      >
        {label}
      </button>
    </div>
  );
}

function StatsMetricCell(value: number | null, formatter?: (n: number) => string): string {
  if (value == null) {
    return '—';
  }
  return formatter ? formatter(value) : String(Math.round(value * 100) / 100);
}

function StatsSummaryTerm({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <dt title={hint}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

type StatsSummaryModal = 'score-list' | 'time-chart' | null;

type StatsTimeChartSortColumn = 'score' | 'title' | 'episodes' | 'episodeLength' | 'time';

type StatsTimeChartSortState = {
  column: StatsTimeChartSortColumn;
  direction: 'asc' | 'desc';
};

function StatsMinCountChip({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useClickOutside(rootRef, open, () => setOpen(false));
  const active = value > 0;
  const label = active ? `min count · ≥ ${value}` : 'min count';

  return (
    <div ref={rootRef} className={`filter-chip ${active ? 'active' : ''}`}>
      <button
        type="button"
        className="filter-chip-button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        title="Minimum parent-row count after other filters"
      >
        {label}
      </button>
      {open && (
        <div className="filter-chip-menu" role="menu">
          <label className="filter-chip-range-row">
            <span>count ≥</span>
            <input
              type="number"
              min={0}
              step={1}
              value={value}
              onChange={(e) =>
                onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))
              }
              className="filter-chip-number"
            />
          </label>
        </div>
      )}
    </div>
  );
}

function StatsSubrowNameCell({
  entry,
  link,
  onOpenMedia,
}: {
  entry: StatsEntry;
  link?: StatsSubrowLink;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const anilistLink = bindAnilistMiddleClick(
    anilistUrlForMediaEntry(entry.mediaType, entry.mediaId),
  );
  const repeatSuffix =
    entry.repeat != null && entry.repeat > 0 ? ` ×${entry.repeat + 1}` : '';
  const vaCharacters = link?.characters ?? [];
  const hasVaCharacters = vaCharacters.length > 0;
  const hasLegacyCharacter = link?.characterName != null;
  const staffRole = link?.staffRole;

  return (
    <div className="tool-stats-subrow-name">
      <button
        type="button"
        className={mergeAnilistLinkClass('tool-stats-subrow-show-btn', anilistLink.className)}
        title={`${entry.title} (middle-click for AniList)`}
        onClick={() => onOpenMedia(entry.mediaId, entry.title)}
        onMouseDown={anilistLink.onMouseDown}
        onAuxClick={anilistLink.onAuxClick}
      >
        <ToolEntityAvatar imageUrl={entry.coverImage} label={entry.title} variant="poster" />
        <span className="tool-stats-subrow-show-text">
          <span className="tool-stats-subrow-show-title">
            {entry.title}
            {repeatSuffix ? <span className="tool-stats-repeat">{repeatSuffix}</span> : null}
          </span>
          {hasVaCharacters ? (
            <span className="tool-stats-subrow-show-meta">
              {vaCharacters.map((character, index) => (
                <span key={character.characterId}>
                  {index > 0 ? ', ' : ''}
                  <ToolCharacterName
                    characterId={character.characterId}
                    name={character.characterName}
                  />
                  {character.characterRole ? ` (${character.characterRole})` : ''}
                </span>
              ))}
            </span>
          ) : hasLegacyCharacter ? (
            <span className="tool-stats-subrow-show-meta">
              <ToolCharacterName
                characterId={link?.characterId ?? 0}
                name={link?.characterName ?? ''}
              />
              {link?.characterRole ? ` (${link.characterRole})` : ''}
            </span>
          ) : staffRole ? (
            <span className="tool-stats-subrow-show-meta">{staffRole}</span>
          ) : null}
        </span>
      </button>
    </div>
  );
}

function StatsMostCommonScoreModal({
  score,
  entries,
  onClose,
  onOpenMedia,
}: {
  score: number;
  entries: StatsEntry[];
  onClose: () => void;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  return (
    <Modal
      label={`Most Common Score (${score})`}
      onClose={onClose}
      className="modal-wide"
    >
      <h3 className="tool-stats-modal-title">
        Most Common Score ({score})
        <span className="tool-stats-modal-subtitle">({entries.length} shows)</span>
      </h3>
      <ul className="tool-rank-list tool-stats-score-list">
        {entries.map((entry) => (
          <li key={entry.mediaId}>
            <ToolShowButton
              mediaId={entry.mediaId}
              title={entry.title}
              coverImage={entry.coverImage}
              mediaType={entry.mediaType}
              onOpenMedia={onOpenMedia}
              compact
            />
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function StatsTimeWatchedChartModal({
  rows,
  onClose,
  onOpenMedia,
}: {
  rows: StatsTimeWatchedRow[];
  onClose: () => void;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const [sort, setSort] = useState<StatsTimeChartSortState>({
    column: 'time',
    direction: 'desc',
  });

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      switch (sort.column) {
        case 'score':
          return compareStatsSortValues(
            statsEntryScoreSortValue(a.entry),
            statsEntryScoreSortValue(b.entry),
            sort.direction,
          );
        case 'title':
          return compareStatsSortValues(a.entry.title, b.entry.title, sort.direction);
        case 'episodes':
          return compareStatsSortValues(
            statsEffectiveEpisodes(a.entry),
            statsEffectiveEpisodes(b.entry),
            sort.direction,
          );
        case 'episodeLength': {
          const aLen = a.entry.duration ?? 0;
          const bLen = b.entry.duration ?? 0;
          return compareStatsSortValues(aLen, bLen, sort.direction);
        }
        case 'time':
        default:
          return compareStatsSortValues(a.minutes, b.minutes, sort.direction);
      }
    });
    return copy;
  }, [rows, sort]);

  const totals = useMemo(() => {
    let episodes = 0;
    let minutes = 0;
    for (const row of rows) {
      episodes += statsEffectiveEpisodes(row.entry);
      minutes += row.minutes;
    }
    return { episodes, minutes };
  }, [rows]);

  const onSort = (column: StatsTimeChartSortColumn) => {
    setSort((prev) => {
      if (prev.column !== column) {
        return {
          column,
          direction: column === 'title' ? 'asc' : 'desc',
        };
      }
      return { column, direction: prev.direction === 'desc' ? 'asc' : 'desc' };
    });
  };

  const sortIndicator = (column: StatsTimeChartSortColumn): string | null => {
    if (sort.column !== column) {
      return null;
    }
    return sort.direction === 'desc' ? '↓' : '↑';
  };

  return (
    <Modal label="Time watched by show" onClose={onClose} className="modal-stats-time-watched">
      <h3 className="tool-stats-modal-title">Time watched by show</h3>
      <DragScroll className="tool-stats-time-chart-scroll">
        <table className="tool-stats-time-chart">
          <thead>
            <tr>
              <th
                className="tool-chart-sort-th tool-stats-time-chart-score-head"
                onClick={() => onSort('score')}
              >
                Score
                {sortIndicator('score') ? (
                  <span
                    className="tool-chart-sort-indicator tool-chart-sort-indicator--parent"
                    aria-hidden="true"
                  >
                    {sortIndicator('score')}
                  </span>
                ) : null}
              </th>
              <th className="tool-chart-sort-th tool-stats-time-chart-show-head" onClick={() => onSort('title')}>
                Show
                {sortIndicator('title') ? (
                  <span
                    className="tool-chart-sort-indicator tool-chart-sort-indicator--parent"
                    aria-hidden="true"
                  >
                    {sortIndicator('title')}
                  </span>
                ) : null}
              </th>
              <th className="tool-chart-sort-th" onClick={() => onSort('episodes')}>
                Episodes watched
                {sortIndicator('episodes') ? (
                  <span
                    className="tool-chart-sort-indicator tool-chart-sort-indicator--parent"
                    aria-hidden="true"
                  >
                    {sortIndicator('episodes')}
                  </span>
                ) : null}
              </th>
              <th className="tool-chart-sort-th" onClick={() => onSort('episodeLength')}>
                Episode length
                {sortIndicator('episodeLength') ? (
                  <span
                    className="tool-chart-sort-indicator tool-chart-sort-indicator--parent"
                    aria-hidden="true"
                  >
                    {sortIndicator('episodeLength')}
                  </span>
                ) : null}
              </th>
              <th className="tool-chart-sort-th" onClick={() => onSort('time')}>
                Time watched
                {sortIndicator('time') ? (
                  <span
                    className="tool-chart-sort-indicator tool-chart-sort-indicator--parent"
                    aria-hidden="true"
                  >
                    {sortIndicator('time')}
                  </span>
                ) : null}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const entry = row.entry;
              const episodeLength = entry.duration ?? null;
              return (
                <tr key={entry.mediaId}>
                  <td className="tool-stats-time-chart-score">
                    <span
                      className={[ 'tool-season-score', statsScoreToneClass(entry) ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {formatStatsScoreCell(entry)}
                    </span>
                  </td>
                  <td className="tool-stats-time-chart-show">
                    <ToolShowButton
                      mediaId={entry.mediaId}
                      title={entry.title}
                      coverImage={entry.coverImage}
                      mediaType={entry.mediaType}
                      onOpenMedia={onOpenMedia}
                      compact
                    />
                  </td>
                  <td className="tool-stats-time-chart-metric">{statsEffectiveEpisodes(entry)}</td>
                  <td className="tool-stats-time-chart-metric">
                    {episodeLength != null ? formatStatsDuration(episodeLength) : '—'}
                  </td>
                  <td className="tool-stats-time-chart-metric">{formatStatsDuration(row.minutes)}</td>
                </tr>
              );
            })}
            <tr className="tool-stats-time-chart-total-row">
              <td className="tool-stats-time-chart-score"></td>
              <td className="tool-stats-time-chart-total-label">Sum</td>
              <td className="tool-stats-time-chart-metric">{totals.episodes}</td>
              <td className="tool-stats-time-chart-metric">—</td>
              <td className="tool-stats-time-chart-metric">
                {formatStatsDurationWithDayCount(totals.minutes)}
              </td>
            </tr>
          </tbody>
        </table>
      </DragScroll>
    </Modal>
  );
}

function StatsSummarySection({
  summary,
  mediaType,
  onOpenScoreList,
  onOpenTimeChart,
}: {
  summary: StatsSummary;
  mediaType: StatsForm['mediaType'];
  onOpenScoreList: () => void;
  onOpenTimeChart: () => void;
}) {
  return (
    <div className="tool-stats-summary-rows">
      <dl className="tool-stats-summary-grid">
        <StatsSummaryTerm label="On list">{summary.onList}</StatsSummaryTerm>
        <StatsSummaryTerm label="Rated">{summary.rated}</StatsSummaryTerm>
        <StatsSummaryTerm label="Mean score">{StatsMetricCell(summary.meanScore)}</StatsSummaryTerm>
        <StatsSummaryTerm label="Median">{StatsMetricCell(summary.medianScore)}</StatsSummaryTerm>
      </dl>
      <dl className="tool-stats-summary-grid">
        <StatsSummaryTerm
          label={mediaType === 'ANIME' ? 'Duration-weighted mean' : 'Chapter-weighted mean'}
          hint={STATS_TIME_WEIGHTED_MEAN_TOOLTIP}
        >
          {StatsMetricCell(summary.weightedMeanScore)}
        </StatsSummaryTerm>
        <StatsSummaryTerm label="Global difference" hint={STATS_GLOBAL_DIFFERENCE_TOOLTIP}>
          {StatsMetricCell(summary.globalDifference)}
        </StatsSummaryTerm>
        <StatsSummaryTerm label="Global deviation" hint={STATS_GLOBAL_DEVIATION_TOOLTIP}>
          {StatsMetricCell(summary.globalDeviation)}
        </StatsSummaryTerm>
        <StatsSummaryTerm label="Rating entropy" hint={STATS_RATING_ENTROPY_TOOLTIP}>
          {StatsMetricCell(summary.ratingEntropy)} bits/rating
        </StatsSummaryTerm>
      </dl>
      <dl className="tool-stats-summary-grid">
        <StatsSummaryTerm label="Most common score">
          {summary.mostCommonScore != null ? (
            <button
              type="button"
              className="tool-stats-summary-link"
              onClick={onOpenScoreList}
            >
              {summary.mostCommonScore} ({summary.mostCommonScoreCount})
            </button>
          ) : (
            '—'
          )}
        </StatsSummaryTerm>
        {mediaType === 'ANIME' ? (
          <>
            <StatsSummaryTerm label="Time watched">
              {summary.timeWatchedMinutes > 0 ? (
                <button
                  type="button"
                  className="tool-stats-summary-link"
                  onClick={onOpenTimeChart}
                >
                  {formatStatsDurationWithDayCount(summary.timeWatchedMinutes)}
                </button>
              ) : (
                formatStatsDurationWithDayCount(summary.timeWatchedMinutes)
              )}
            </StatsSummaryTerm>
            <StatsSummaryTerm label="Episodes watched">{summary.episodesWatched}</StatsSummaryTerm>
            <StatsSummaryTerm label="Episodes remaining" hint={STATS_EPISODES_REMAINING_TOOLTIP}>
              {summary.episodesRemaining}
            </StatsSummaryTerm>
          </>
        ) : (
          <>
            <StatsSummaryTerm label="Chapters read">{summary.chaptersRead}</StatsSummaryTerm>
            <StatsSummaryTerm label="Chapters remaining" hint={STATS_CHAPTERS_REMAINING_TOOLTIP}>
              {summary.chaptersRemaining}
            </StatsSummaryTerm>
          </>
        )}
      </dl>
    </div>
  );
}

function StatsCappedChart({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="tool-chart-fullbleed tool-season-fullbleed">
      <div className="tool-stats-scroll-card">
        <DragScroll className="tool-chart-body-scroll tool-stats-results-scroll">
          {children}
        </DragScroll>
      </div>
    </div>
  );
}

function StatsTable({
  title,
  rows,
  mediaType,
  tableSort,
  onParentSort,
  onSubrowSort,
  showMainRoleInfo,
  showDiff,
  onOpenMedia,
  onOpenStaff,
  expandedKeys,
  onToggleExpand,
  emptyMessage,
}: {
  title: string;
  rows: StatsParentRow[];
  mediaType: StatsForm['mediaType'];
  tableSort: StatsTableSortConfig;
  onParentSort: (column: StatsSortColumn) => void;
  onSubrowSort: (column: StatsSortColumn) => void;
  showMainRoleInfo: boolean;
  showDiff: boolean;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
  onOpenStaff: ToolPanelProps['onOpenStaff'];
  expandedKeys: Set<string>;
  onToggleExpand: (key: string) => void;
  emptyMessage?: string;
}) {
  const isAnime = mediaType === 'ANIME';
  const columns: { key: StatsSortColumn; label: string }[] = [
    { key: 'name', label: 'Name' },
    { key: 'count', label: 'Count' },
    { key: 'meanScore', label: 'Mean Score' },
    { key: 'anilistMeanScore', label: 'Anilist Score' },
  ];
  if (showMainRoleInfo) {
    columns.push(
      { key: 'mainRoleCount', label: 'Main Role Count' },
      { key: 'mainRoleMeanScore', label: 'Main Role Mean Score' },
      { key: 'mainRoleAnilistMeanScore', label: 'Main Role Anilist Score' },
    );
  }
  if (showDiff) {
    columns.push({ key: 'scoreDiff', label: 'DIFF' });
  }
  if (isAnime) {
    columns.push(
      { key: 'episodesWatched', label: 'Episodes' },
      { key: 'timeWatched', label: 'Time Watched' },
      { key: 'episodesRemaining', label: 'Eps Remaining' },
      { key: 'timeRemaining', label: 'Time Remaining' },
    );
  } else {
    columns.push(
      { key: 'chaptersRead', label: 'Chapters' },
      { key: 'chaptersRemaining', label: 'Chapters Remaining' },
      { key: 'volumesRead', label: 'Volumes' },
      { key: 'volumesRemaining', label: 'Volumes Remaining' },
    );
  }

  const exportCsv = () => {
    const csv = buildStatsTableCsv(
      rows,
      columns.map((c) => c.label),
      (row) => [
        row.name,
        String(row.metrics.count),
        StatsMetricCell(row.metrics.meanScore),
        StatsMetricCell(row.metrics.anilistMeanScore),
        ...(showMainRoleInfo
          ? [
              StatsMetricCell(row.metrics.mainRoleCount),
              StatsMetricCell(row.metrics.mainRoleMeanScore),
              StatsMetricCell(row.metrics.mainRoleAnilistMeanScore),
            ]
          : []),
        ...(showDiff ? [StatsMetricCell(row.metrics.scoreDiff)] : []),
        ...(isAnime
          ? [
              String(row.metrics.episodesWatched),
              formatStatsDuration(row.metrics.timeWatchedMinutes),
              String(row.metrics.episodesRemaining),
              formatStatsDuration(row.metrics.timeRemainingMinutes),
            ]
          : [
              String(row.metrics.chaptersRead),
              String(row.metrics.chaptersRemaining),
              String(row.metrics.volumesRead),
              String(row.metrics.volumesRemaining),
            ]),
      ],
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/\s+/g, '_').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportJson = () => {
    const blob = new Blob([buildStatsTableJson(rows)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/\s+/g, '_').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="tool-stats-table-block">
      <div className="tool-stats-table-header">
        <h3 className="tool-stats-table-title">{title}</h3>
        <div className="tool-stats-table-actions">
          <button type="button" className="btn small" onClick={exportCsv}>CSV</button>
          <button type="button" className="btn small" onClick={exportJson}>JSON</button>
        </div>
      </div>
      {rows.length === 0 && emptyMessage ? (
        <p className="tool-empty tool-stats-table-empty">{emptyMessage}</p>
      ) : (
      <DragScroll className="tool-stats-table-scroll">
        <table className="tool-stats-table">
          <thead>
            <tr>
              {columns.map((col) => {
                const parentActive = tableSort.parent?.column === col.key;
                const parentIndicator = parentActive
                  ? tableSort.parent?.direction === 'desc'
                    ? '↓'
                    : '↑'
                  : null;
                const subrowActive = tableSort.subrow?.column === col.key;
                const subrowIndicator = subrowActive
                  ? tableSort.subrow?.direction === 'desc'
                    ? '↓'
                    : '↑'
                  : null;
                return (
                  <th
                    key={col.key}
                    className={[
                      'tool-chart-sort-th',
                      parentActive ? 'tool-chart-sort-th--active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => onParentSort(col.key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onSubrowSort(col.key);
                    }}
                  >
                    {col.label}
                    {parentIndicator ? (
                      <span
                        className="tool-chart-sort-indicator tool-chart-sort-indicator--parent"
                        aria-hidden="true"
                      >
                        {parentIndicator}
                      </span>
                    ) : null}
                    {subrowIndicator ? (
                      <span
                        className="tool-chart-sort-indicator tool-chart-sort-indicator--subrow"
                        aria-hidden="true"
                      >
                        {subrowIndicator}
                      </span>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rank) => {
              const expanded = expandedKeys.has(row.key);
              return (
                <Fragment key={row.key}>
                  <tr
                    key={row.key}
                    className="tool-stats-parent-row"
                    onClick={() => onToggleExpand(row.key)}
                  >
                    <td className="tool-stats-name-cell">
                      <span className="tool-stats-rank">{rank + 1}.</span>
                      {row.staffId != null ? (
                        <span
                          className="tool-stats-staff-hit"
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <ToolStaffButton
                            staffId={row.staffId}
                            name={row.name}
                            imageUrl={row.staffImage ?? undefined}
                            gender={row.staffGender}
                            onOpenStaff={onOpenStaff}
                            compact
                          />
                        </span>
                      ) : (
                        <span className={row.isNonAnimationStudio ? 'text-muted' : undefined}>{row.name}</span>
                      )}
                    </td>
                    <td>{row.metrics.count}</td>
                    <td>{StatsMetricCell(row.metrics.meanScore)}</td>
                    <td>{StatsMetricCell(row.metrics.anilistMeanScore)}</td>
                    {showMainRoleInfo ? (
                      <>
                        <td>{StatsMetricCell(row.metrics.mainRoleCount)}</td>
                        <td>{StatsMetricCell(row.metrics.mainRoleMeanScore)}</td>
                        <td>{StatsMetricCell(row.metrics.mainRoleAnilistMeanScore)}</td>
                      </>
                    ) : null}
                    {showDiff ? <td>{StatsMetricCell(row.metrics.scoreDiff)}</td> : null}
                    {isAnime ? (
                      <>
                        <td>{row.metrics.episodesWatched}</td>
                        <td>{formatStatsDuration(row.metrics.timeWatchedMinutes)}</td>
                        <td>{row.metrics.episodesRemaining}</td>
                        <td>{formatStatsDuration(row.metrics.timeRemainingMinutes)}</td>
                      </>
                    ) : (
                      <>
                        <td>{row.metrics.chaptersRead}</td>
                        <td>{row.metrics.chaptersRemaining}</td>
                        <td>{row.metrics.volumesRead}</td>
                        <td>{row.metrics.volumesRemaining}</td>
                      </>
                    )}
                  </tr>
                  {expanded
                    ? row.subrows.map((sub) => (
                        <StatsSubrowTr
                          key={`${row.key}:${sub.entry.mediaId}`}
                          sub={sub}
                          showMainRoleInfo={showMainRoleInfo}
                          showDiff={showDiff}
                          isAnime={isAnime}
                          onOpenMedia={onOpenMedia}
                        />
                      ))
                    : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </DragScroll>
      )}
    </section>
  );
}

function StatsSubrowTr({
  sub,
  showMainRoleInfo,
  showDiff,
  isAnime,
  onOpenMedia,
}: {
  sub: StatsSubrow;
  showMainRoleInfo: boolean;
  showDiff: boolean;
  isAnime: boolean;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const entry = sub.entry;
  const isMainRole = statsSubrowHasMainRole(sub.link);
  const rated = statsRatedScore(entry);
  const scoreDiff =
    showDiff && rated != null && entry.meanScore != null && entry.meanScore > 0
      ? rated - entry.meanScore
      : null;

  return (
    <tr className="tool-stats-subrow">
      <td className="tool-stats-name-cell">
        <StatsSubrowNameCell entry={entry} link={sub.link} onOpenMedia={onOpenMedia} />
      </td>
      <td>1</td>
      <td>
        <span className={statsScoreToneClass(entry)}>{formatStatsScoreCell(entry)}</span>
      </td>
      <td>{entry.meanScore ?? '—'}</td>
      {showMainRoleInfo ? (
        <>
          <td>{isMainRole ? 1 : '—'}</td>
          <td>{isMainRole && rated != null ? rated : '—'}</td>
          <td>{isMainRole && entry.meanScore != null ? entry.meanScore : '—'}</td>
        </>
      ) : null}
      {showDiff ? <td>{scoreDiff != null ? StatsMetricCell(scoreDiff) : '—'}</td> : null}
      {isAnime ? (
        <>
          <td>{entry.progress}</td>
          <td>{formatStatsDuration((entry.duration ?? 1) * (entry.progress ?? 0))}</td>
          <td>{entryEpisodesRemaining(entry)}</td>
          <td>{formatStatsDuration(entryTimeRemainingMinutes(entry))}</td>
        </>
      ) : (
        <>
          <td>{entry.progress}</td>
          <td>{entryChaptersRemaining(entry)}</td>
          <td>{entry.progressVolumes ?? 0}</td>
          <td>{entryVolumesRemaining(entry)}</td>
        </>
      )}
    </tr>
  );
}

export function StatsPanel({
  onOpenMedia,
  onOpenStaff,
}: ToolPanelProps): React.ReactElement {
  const [form, setForm] = useState<StatsForm>(() => loadForm());
  const [cached, setCached] = useState<StatsCachedData | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<StatsFetchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartSorts, setChartSorts] = useState(() => createDefaultStatsChartSorts());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [summaryModal, setSummaryModal] = useState<StatsSummaryModal>(null);
  const abortRef = useRef<AbortController | null>(null);
  const displayLabelRevision = useToolsDisplayLabelRevision();

  const patchForm = useCallback((patch: Partial<StatsForm>) => {
    setForm((prev) => {
      let next = { ...prev, ...patch };
      if (patch.mediaType && patch.mediaType !== prev.mediaType) {
        next = {
          ...next,
          aggregationType: normalizeStatsAggregationType(next.aggregationType, patch.mediaType),
          formatFilters:
            patch.mediaType === 'MANGA'
              ? normalizeStatsMangaFormatFilters(next.formatFilters)
              : normalizeStatsAnimeFormatFilters(next.formatFilters),
          staffRoleFilters: normalizeStatsStaffRoleFilters(next.staffRoleFilters, patch.mediaType),
        };
      }
      saveForm(next);
      return next;
    });
  }, []);

  const { refreshing: refreshingList, refreshUsernameList } = useUsernameListRefresh({
    refreshManga: true,
    onAfterRefresh: (username) => {
      bustStatsSessionMemo(username, 'ANIME');
      bustStatsSessionMemo(username, 'MANGA');
    },
  });

  const runFetch = useCallback(
    async (options?: { forceRefresh?: boolean; expandCast?: boolean }) => {
      const username = form.username.trim();
      if (!username) {
        setError('Username is required.');
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setError(null);
      setProgress(null);
      try {
        const needsCast = options?.expandCast === true;
        const fetchOptions = {
          forceRefresh: options?.forceRefresh,
          onProgress: setProgress,
          signal: controller.signal,
        };
        const data = await fetchStatsData(username, form.mediaType, fetchOptions);
        if (controller.signal.aborted) {
          return;
        }
        if (needsCast && statsCachedNeedsCast(data)) {
          const expanded = await expandStatsCast(data, fetchOptions);
          if (controller.signal.aborted) {
            return;
          }
          setChartSorts(createDefaultStatsChartSorts());
          setCached(expanded);
        } else {
          setChartSorts(createDefaultStatsChartSorts());
          setCached(data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
          setProgress(null);
        }
      }
    },
    [form.mediaType, form.username],
  );

  const onCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setProgress(null);
    const handle = form.username.trim().toLowerCase();
    if (handle) {
      bustStatsSessionMemo(handle, form.mediaType);
    }
  }, [form.mediaType, form.username]);

  const onRun = useCallback(
    (forceRefresh = false) => {
      const expandCast =
        !form.showSummary &&
        (form.aggregationType === 'STAFF' || form.aggregationType === 'VA');
      void runFetch({ forceRefresh, expandCast });
    },
    [form.aggregationType, form.showSummary, runFetch],
  );

  const onToggleShowSummary = useCallback(() => {
    const nextShowSummary = !form.showSummary;
    patchForm({ showSummary: nextShowSummary });
    if (nextShowSummary && !cached && !running && form.username.trim()) {
      void runFetch({ expandCast: false });
    }
  }, [cached, form.showSummary, form.username, patchForm, running, runFetch]);

  const onExpandCast = useCallback(() => {
    if (!cached) {
      void runFetch({ expandCast: true });
      return;
    }
    if (!statsCachedNeedsCast(cached)) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setProgress(null);
    void expandStatsCast(cached, {
      onProgress: setProgress,
      signal: controller.signal,
    })
      .then((expanded) => {
        if (!controller.signal.aborted) {
          setCached(expanded);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setRunning(false);
          setProgress(null);
        }
      });
  }, [cached, runFetch]);

  useEffect(() => {
    if (!cached) {
      return;
    }
    const handle = form.username.trim().toLowerCase();
    if (
      handle !== cached.username.trim().toLowerCase() ||
      cached.mediaType !== form.mediaType
    ) {
      setCached(null);
    }
  }, [cached, form.mediaType, form.username]);

  useEffect(() => {
    if (!cached || running || form.showSummary) {
      return;
    }
    const needsCastAggregation =
      form.aggregationType === 'STAFF' || form.aggregationType === 'VA';
    if (needsCastAggregation && statsCachedNeedsCast(cached)) {
      onExpandCast();
    }
  }, [cached, form.aggregationType, form.showSummary, onExpandCast, running]);

  const displayCached = useMemo(() => {
    if (!cached) {
      return null;
    }
    return relabelStatsEntries(cached);
  }, [cached, displayLabelRevision]);

  const filteredPool = useMemo(() => {
    if (!displayCached) {
      return null;
    }
    return filterStatsPool(displayCached.entries, form);
  }, [
    displayCached,
    form.mediaType,
    form.mediaStatusFilters,
    form.formatFilters,
    form.listStatusFilters,
    form.userScoreInclude,
    form.scoreMin,
    form.scoreMax,
  ]);

  const built = useMemo((): StatsBuildResult | null => {
    if (!filteredPool) {
      return null;
    }
    return {
      pool: filteredPool,
      summary: buildStatsSummary(filteredPool),
      ...buildActiveStatsChartRows(filteredPool, form),
    };
  }, [
    filteredPool,
    form.showSummary,
    form.aggregationType,
    form.staffRoleFilters,
    form.vaRoleFilters,
    form.tagOptions,
    form.studioKindFilters,
  ]);

  const mostCommonScoreEntries = useMemo(() => {
    if (!built?.summary?.mostCommonScore) {
      return [];
    }
    return filterStatsPoolByRatingScore(built.pool, built.summary.mostCommonScore);
  }, [built]);

  const timeWatchedRows = useMemo(() => {
    if (!built || form.mediaType !== 'ANIME') {
      return [];
    }
    return buildStatsTimeWatchedRows(built.pool);
  }, [built, form.mediaType]);

  const sortOptions = useMemo(
    () => ({
      mediaType: form.mediaType,
      vaShowDiff: form.vaShowDiff,
    }),
    [form.mediaType, form.vaShowDiff],
  );

  const sortChartRows = useCallback(
    (chartId: StatsTableChartId, rows: StatsParentRow[]): StatsParentRow[] => {
      const filtered = filterStatsParentRowsByMinCount(rows, form.minCount);
      return applyStatsTableSort(filtered, chartSorts[chartId], sortOptions);
    },
    [chartSorts, form.minCount, sortOptions],
  );

  const sortedStaffRows = useMemo(
    () =>
      built && !form.showSummary && form.aggregationType === 'STAFF'
        ? sortChartRows('staff', built.staffRows)
        : [],
    [built, form.aggregationType, form.showSummary, sortChartRows],
  );
  const sortedVaRows = useMemo(
    () =>
      built && !form.showSummary && form.aggregationType === 'VA'
        ? sortChartRows('va', built.vaRows)
        : [],
    [built, form.aggregationType, form.showSummary, sortChartRows],
  );
  const sortedGenreRows = useMemo(
    () =>
      built && !form.showSummary && form.aggregationType === 'GENRES_TAGS'
        ? sortChartRows('genres', built.genreRows)
        : [],
    [built, form.aggregationType, form.showSummary, sortChartRows],
  );
  const sortedTagRows = useMemo(
    () =>
      built && !form.showSummary && form.aggregationType === 'GENRES_TAGS'
        ? sortChartRows('tags', built.tagRows)
        : [],
    [built, form.aggregationType, form.showSummary, sortChartRows],
  );
  const sortedCustomTagRows = useMemo(
    () =>
      built && !form.showSummary && form.aggregationType === 'GENRES_TAGS'
        ? sortChartRows('customTags', built.customTagRows)
        : [],
    [built, form.aggregationType, form.showSummary, sortChartRows],
  );
  const sortedStudioRows = useMemo(
    () =>
      built && !form.showSummary && form.aggregationType === 'STUDIOS'
        ? sortChartRows('studios', built.studioRows)
        : [],
    [built, form.aggregationType, form.showSummary, sortChartRows],
  );

  const castNeedsExpand = cached != null && statsCachedNeedsCast(cached);
  const aggregationEmptyHint = statsAggregationEmptyHint(form.aggregationType, castNeedsExpand);

  const onParentSort = useCallback((chartId: StatsTableChartId, column: StatsSortColumn) => {
    setChartSorts((prev) => ({
      ...prev,
      [chartId]: {
        ...prev[chartId],
        parent: cycleStatsParentSort(prev[chartId].parent, column),
      },
    }));
  }, []);

  const onSubrowSort = useCallback((chartId: StatsTableChartId, column: StatsSortColumn) => {
    setChartSorts((prev) => ({
      ...prev,
      [chartId]: {
        ...prev[chartId],
        subrow: cycleStatsSubrowSort(prev[chartId].subrow, column),
      },
    }));
  }, []);

  const onToggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const showResults =
    built != null &&
    cached != null &&
    cached.mediaType === form.mediaType &&
    cached.username.trim().toLowerCase() === form.username.trim().toLowerCase();
  const aggregationOptions = availableStatsAggregationTypes(form.mediaType);
  const staffRoleOptions =
    form.mediaType === 'MANGA' ? statsMangaStaffRoleOptions() : statsAnimeStaffRoleOptions();

  return (
    <section className="tool-panel tool-stats-panel">
      <p className="tool-panel-lead">
        Aggregate list statistics by voice actor, staff, genres, tags, or studios — port of addMoreStats.js from automail.
        <br />
        Click on each row to show the subrows — the individual entries that make up the parent row.
        <br />
        Right click on the header to sort the subrows within each parent row.
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
        <div className="tool-adaptation-primary-filters tool-seasonal-primary-filters tool-stats-primary-filters">
          <ToolUsernameField
            label="AniList username"
            value={form.username}
            disabled={running}
            refreshing={refreshingList}
            onChange={(username) => patchForm({ username: withLastAnilistUsername(username) })}
            onRefresh={() => refreshUsernameList(form.username, running)}
            refreshLabel="Refresh list from AniList"
          />
          <MultiSelectChip
            label="list status"
            options={[...STATS_LIST_STATUS_OPTIONS]}
            selected={form.listStatusFilters}
            formatOption={(s) => s}
            onToggle={(status) =>
              patchForm({ listStatusFilters: toggleInArray(form.listStatusFilters, status) })
            }
          />
          <ScoreRangeChip
            pill={form.userScoreInclude}
            min={form.scoreMin}
            max={form.scoreMax}
            onChange={(patch) => patchForm(patch)}
          />
          <StatsToggleChip
            label="User Stats Summary"
            active={form.showSummary}
            disabled={running}
            onToggle={onToggleShowSummary}
            title="Replace the chart with AniList-style summary totals for the filtered pool"
          />
        </div>

        <div className="tool-adaptation-primary-filters tool-seasonal-primary-filters">
          <ToolAnimeMangaMediaTypeFilter
            value={form.mediaType}
            disabled={running}
            onChange={(mediaType) =>
              patchForm({ mediaType, aggregationType: defaultAggregationFor(mediaType) })
            }
          />

          <MultiSelectChip
            label="airing status"
            options={[...STATS_MEDIA_STATUS_OPTIONS]}
            selected={form.mediaStatusFilters}
            formatOption={formatStatsMediaStatusLabel}
            onToggle={(status) =>
              patchForm({ mediaStatusFilters: toggleInArray(form.mediaStatusFilters, status) })
            }
          />

          <MultiSelectChip
            label="format"
            options={
              form.mediaType === 'MANGA'
                ? [...STATS_MANGA_FORMAT_OPTIONS]
                : [...STATS_ANIME_FORMAT_OPTIONS]
            }
            selected={form.formatFilters}
            formatOption={(f) => formatStatsFormatLabel(f)}
            onToggle={(format) =>
              patchForm({
                formatFilters: toggleInArray(form.formatFilters as string[], format) as StatsForm['formatFilters'],
              })
            }
          />

          <StatsMinCountChip
            value={form.minCount}
            onChange={(minCount) => patchForm({ minCount })}
          />
        </div>

        <div className="tool-adaptation-primary-filters tool-seasonal-primary-filters tool-stats-type-filters">
          <ToolSegmentedFilter
            label="Stats Chart"
            options={aggregationOptions.map((type) => ({
              value: type,
              label: AGGREGATION_LABELS[type],
            }))}
            value={form.aggregationType}
            disabled={running}
            onChange={(aggregationType) => patchForm({ aggregationType })}
          />

          {form.aggregationType === 'STAFF' ? (
            <MultiSelectChip
              label="production roles"
              options={staffRoleOptions}
              selected={form.staffRoleFilters}
              formatOption={(role) => role === 'OTHER' ? 'Other' : role}
              onToggle={(role) =>
                patchForm({ staffRoleFilters: toggleInArray(form.staffRoleFilters, role) })
              }
              onReplaceAll={(roles) =>
                patchForm({ staffRoleFilters: [...roles] })
              }
            />
          ) : null}

          {form.aggregationType === 'VA' ? (
            <>
              <MultiSelectChip
                label="character roles"
                options={[...STATS_CHARACTER_ROLE_OPTIONS]}
                selected={form.vaRoleFilters}
                formatOption={(r) => r}
                onToggle={(role) =>
                  patchForm({ vaRoleFilters: toggleInArray(form.vaRoleFilters, role) })
                }
              />
              <StatsToggleChip
                label="Main Role Info"
                active={form.vaShowMainRoleInfo}
                disabled={running}
                onToggle={() => patchForm({ vaShowMainRoleInfo: !form.vaShowMainRoleInfo })}
                title="Show main-role count and score columns (does not filter rows)"
              />
              <StatsToggleChip
                label="Anilist/User Score Diff"
                active={form.vaShowDiff}
                disabled={running}
                onToggle={() => patchForm({ vaShowDiff: !form.vaShowDiff })}
              />
            </>
          ) : null}

          {form.aggregationType === 'GENRES_TAGS' ? (
            <TagOptionsChip
              mode={form.tagOptions.tagMode}
              minRank={form.tagOptions.tagMinRank}
              showModeToggle={false}
              onChange={(patch) =>
                patchForm({
                  tagOptions: {
                    ...form.tagOptions,
                    ...(patch.tagMinRank != null ? { tagMinRank: patch.tagMinRank } : {}),
                  },
                })
              }
            />
          ) : null}

          {form.aggregationType === 'STUDIOS' ? (
            <MultiSelectChip
              label="studio type"
              options={[...STATS_STUDIO_KIND_OPTIONS]}
              selected={form.studioKindFilters}
              formatOption={(k) => (k === 'animation' ? 'Animation' : 'Non-animation')}
              onToggle={(kind) =>
                patchForm({ studioKindFilters: toggleInArray(form.studioKindFilters, kind) })
              }
            />
          ) : null}
        </div>

        <div className="tool-actions">
          <ToolRunButton label="Run" running={running} onRun={(force) => onRun(force)} />
          {(form.aggregationType === 'STAFF' || form.aggregationType === 'VA') && (
            <button
              type="button"
              className="btn"
              disabled={running || (cached != null && !statsCachedNeedsCast(cached))}
              onClick={onExpandCast}
            >
              Expand all cast
            </button>
          )}
          {running && (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>

        {describeProgress(progress) && <p className="tool-status">{describeProgress(progress)}</p>}
        {cached != null &&
          (cached.staleCastMediaCount ?? 0) > 0 &&
          (form.aggregationType === 'STAFF' || form.aggregationType === 'VA') && (
            <p
              className="tool-status settings-anilist-hint settings-cache-stale"
              role="status"
            >
              Cast data for {cached.staleCastMediaCount} show
              {cached.staleCastMediaCount === 1 ? '' : 's'} is older than 90 days. Use ↻ on the
              username field or refresh individual shows in the media modal.
            </p>
          )}
        {error && <p className="tool-error">{error}</p>}
      </form>

      {showResults && built && (
        <>
          {form.showSummary && built.summary ? (
            <StatsSummarySection
              summary={built.summary}
              mediaType={form.mediaType}
              onOpenScoreList={() => setSummaryModal('score-list')}
              onOpenTimeChart={() => setSummaryModal('time-chart')}
            />
          ) : (
            <>
              {form.aggregationType === 'STAFF' && (
                <StatsCappedChart>
                  <StatsTable
                    title="Staff"
                    rows={sortedStaffRows}
                    mediaType={form.mediaType}
                    tableSort={chartSorts.staff}
                    onParentSort={(column) => onParentSort('staff', column)}
                    onSubrowSort={(column) => onSubrowSort('staff', column)}
                    showMainRoleInfo={false}
                    showDiff={false}
                    onOpenMedia={onOpenMedia}
                    onOpenStaff={onOpenStaff}
                    expandedKeys={expandedKeys}
                    onToggleExpand={onToggleExpand}
                    emptyMessage={aggregationEmptyHint}
                  />
                </StatsCappedChart>
              )}

              {form.aggregationType === 'VA' && (
                <StatsCappedChart>
                  <StatsTable
                    title="Voice Actors"
                    rows={sortedVaRows}
                    mediaType={form.mediaType}
                    tableSort={chartSorts.va}
                    onParentSort={(column) => onParentSort('va', column)}
                    onSubrowSort={(column) => onSubrowSort('va', column)}
                    showMainRoleInfo={form.vaShowMainRoleInfo}
                    showDiff={form.vaShowDiff}
                    onOpenMedia={onOpenMedia}
                    onOpenStaff={onOpenStaff}
                    expandedKeys={expandedKeys}
                    onToggleExpand={onToggleExpand}
                    emptyMessage={aggregationEmptyHint}
                  />
                </StatsCappedChart>
              )}

              {form.aggregationType === 'GENRES_TAGS' && (
                <>
                  <StatsCappedChart>
                    <StatsTable
                      title="Genres"
                      rows={sortedGenreRows}
                      mediaType={form.mediaType}
                      tableSort={chartSorts.genres}
                      onParentSort={(column) => onParentSort('genres', column)}
                      onSubrowSort={(column) => onSubrowSort('genres', column)}
                      showMainRoleInfo={false}
                      showDiff={false}
                      onOpenMedia={onOpenMedia}
                      onOpenStaff={onOpenStaff}
                      expandedKeys={expandedKeys}
                      onToggleExpand={onToggleExpand}
                      emptyMessage={aggregationEmptyHint}
                    />
                  </StatsCappedChart>
                  <StatsCappedChart>
                    <StatsTable
                      title="AniList Tags"
                      rows={sortedTagRows}
                      mediaType={form.mediaType}
                      tableSort={chartSorts.tags}
                      onParentSort={(column) => onParentSort('tags', column)}
                      onSubrowSort={(column) => onSubrowSort('tags', column)}
                      showMainRoleInfo={false}
                      showDiff={false}
                      onOpenMedia={onOpenMedia}
                      onOpenStaff={onOpenStaff}
                      expandedKeys={expandedKeys}
                      onToggleExpand={onToggleExpand}
                      emptyMessage={aggregationEmptyHint}
                    />
                  </StatsCappedChart>
                  <StatsCappedChart>
                    <StatsTable
                      title="Custom Tags"
                      rows={sortedCustomTagRows}
                      mediaType={form.mediaType}
                      tableSort={chartSorts.customTags}
                      onParentSort={(column) => onParentSort('customTags', column)}
                      onSubrowSort={(column) => onSubrowSort('customTags', column)}
                      showMainRoleInfo={false}
                      showDiff={false}
                      onOpenMedia={onOpenMedia}
                      onOpenStaff={onOpenStaff}
                      expandedKeys={expandedKeys}
                      onToggleExpand={onToggleExpand}
                      emptyMessage={aggregationEmptyHint}
                    />
                  </StatsCappedChart>
                </>
              )}

              {form.aggregationType === 'STUDIOS' && (
                <StatsCappedChart>
                  <StatsTable
                    title="Studios"
                    rows={sortedStudioRows}
                    mediaType={form.mediaType}
                    tableSort={chartSorts.studios}
                    onParentSort={(column) => onParentSort('studios', column)}
                    onSubrowSort={(column) => onSubrowSort('studios', column)}
                    showMainRoleInfo={false}
                    showDiff={false}
                    onOpenMedia={onOpenMedia}
                    onOpenStaff={onOpenStaff}
                    expandedKeys={expandedKeys}
                    onToggleExpand={onToggleExpand}
                    emptyMessage={aggregationEmptyHint}
                  />
                </StatsCappedChart>
              )}
            </>
          )}
        </>
      )}

      {summaryModal === 'score-list' &&
        built?.summary?.mostCommonScore != null && (
          <StatsMostCommonScoreModal
            score={built.summary.mostCommonScore}
            entries={mostCommonScoreEntries}
            onClose={() => setSummaryModal(null)}
            onOpenMedia={onOpenMedia}
          />
        )}

      {summaryModal === 'time-chart' && timeWatchedRows.length > 0 && (
        <StatsTimeWatchedChartModal
          rows={timeWatchedRows}
          onClose={() => setSummaryModal(null)}
          onOpenMedia={onOpenMedia}
        />
      )}
    </section>
  );
}

function defaultAggregationFor(mediaType: StatsForm['mediaType']): StatsAggregationType {
  return mediaType === 'MANGA' ? 'GENRES_TAGS' : 'VA';
}
