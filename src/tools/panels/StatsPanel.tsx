import { useCallback, useMemo, useRef, useState, Fragment } from 'react';
import type { ToolPanelProps } from '../toolTypes';
import { ToolRunButton } from '../ToolRunButton';
import { ToolUsernameField } from '../ToolUsernameField';
import { ToolSegmentedFilter, type ToolSegmentedOption } from '../ToolSegmentedFilter';
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
  type StatsFetchProgress,
} from './statsApi';
import {
  availableStatsAggregationTypes,
  buildStatsResult,
  buildStatsTimeWatchedRows,
  buildStatsTableCsv,
  buildStatsTableJson,
  cycleStatsSort,
  filterStatsPoolByRatingScore,
  DEFAULT_STATS_LIST_STATUS_FILTERS,
  DEFAULT_STATS_MEDIA_STATUS_FILTERS,
  DEFAULT_STATS_TAG_OPTIONS,
  formatStatsDuration,
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
  sortStatsRows,
  statsRatedScore,
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
  type StatsEntry,
  type StatsForm,
  type StatsParentRow,
  type StatsSortColumn,
  type StatsSortState,
  type StatsSubrow,
  type StatsSubrowLink,
  type StatsSummary,
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
  showSummary: true,
  aggregationType: 'VA',
  staffRoleFilters: statsAnimeStaffRoleOptions(),
  vaRoleFilters: [...STATS_CHARACTER_ROLE_OPTIONS],
  vaMainOnly: false,
  vaShowDiff: false,
  tagOptions: { ...DEFAULT_STATS_TAG_OPTIONS },
  studioKindFilters: [...STATS_STUDIO_KIND_OPTIONS],
};

type PersistedStatsForm = Pick<StatsForm, 'username' | 'mediaType' | 'showSummary' | 'aggregationType' | 'vaMainOnly' | 'vaShowDiff'>;

type PersistedStatsFilters = Pick<
  StatsForm,
  | 'mediaStatusFilters'
  | 'formatFilters'
  | 'listStatusFilters'
  | 'userScoreInclude'
  | 'scoreMin'
  | 'scoreMax'
  | 'staffRoleFilters'
  | 'vaRoleFilters'
  | 'tagOptions'
  | 'studioKindFilters'
>;

function loadForm(): StatsForm {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const filtersRaw = localStorage.getItem(LS_FILTERS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PersistedStatsForm>) : {};
    const filters = filtersRaw ? (JSON.parse(filtersRaw) as Partial<PersistedStatsFilters>) : {};
    const mediaType = parsed.mediaType === 'MANGA' ? 'MANGA' : 'ANIME';
    return {
      ...DEFAULT_FORM,
      username: typeof parsed.username === 'string' ? parsed.username : '',
      mediaType,
      showSummary: parsed.showSummary !== false,
      aggregationType: normalizeStatsAggregationType(parsed.aggregationType, mediaType),
      vaMainOnly: parsed.vaMainOnly === true,
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
      staffRoleFilters: normalizeStatsStaffRoleFilters(filters.staffRoleFilters, mediaType),
      vaRoleFilters: normalizeStatsVaRoleFilters(filters.vaRoleFilters),
      tagOptions: normalizeStatsTagOptions(filters.tagOptions),
      studioKindFilters: normalizeStatsStudioKindFilters(filters.studioKindFilters),
    };
  } catch {
    return { ...DEFAULT_FORM };
  }
}

function saveForm(form: StatsForm): void {
  try {
    const persisted: PersistedStatsForm = {
      username: form.username,
      mediaType: form.mediaType,
      showSummary: form.showSummary,
      aggregationType: form.aggregationType,
      vaMainOnly: form.vaMainOnly,
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

const STATS_MEDIA_TYPE_OPTIONS: readonly ToolSegmentedOption<'ANIME' | 'MANGA'>[] = [
  { value: 'ANIME', label: 'Anime' },
  { value: 'MANGA', label: 'Manga' },
];

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

type StatsSummaryModal = 'score-list' | 'time-chart' | null;

type StatsTimeChartSortColumn = 'title' | 'time' | 'score';

type StatsTimeChartSortState = {
  column: StatsTimeChartSortColumn;
  direction: 'asc' | 'desc';
};

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
  const hasCharacter = link?.characterName != null;
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
          {hasCharacter ? (
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
    <Modal label={`Shows rated ${score}`} onClose={onClose} className="modal-wide">
      <h3 className="tool-stats-modal-title">
        Score {score}
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
            <span className={statsScoreToneClass(entry)}>{formatStatsScoreCell(entry)}</span>
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

  const maxMinutes = useMemo(
    () => rows.reduce((max, row) => Math.max(max, row.minutes), 0),
    [rows],
  );

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const dir = sort.direction === 'asc' ? 1 : -1;
    copy.sort((a, b) => {
      switch (sort.column) {
        case 'title':
          return dir * a.entry.title.localeCompare(b.entry.title);
        case 'score': {
          const aScore = statsRatedScore(a.entry) ?? -1;
          const bScore = statsRatedScore(b.entry) ?? -1;
          return dir * (aScore - bScore);
        }
        case 'time':
        default:
          return dir * (a.minutes - b.minutes);
      }
    });
    return copy;
  }, [rows, sort]);

  const onSort = (column: StatsTimeChartSortColumn) => {
    setSort((prev) => {
      if (prev.column !== column) {
        return { column, direction: column === 'title' ? 'asc' : 'desc' };
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
    <Modal label="Time watched by show" onClose={onClose} className="modal-wide">
      <h3 className="tool-stats-modal-title">Time watched by show</h3>
      <DragScroll className="tool-stats-time-chart-scroll">
        <table className="tool-stats-time-chart">
          <thead>
            <tr>
              <th
                className="tool-chart-sort-th"
                onClick={() => onSort('title')}
              >
                Title
                {sortIndicator('title') ? (
                  <span className="tool-chart-sort-indicator" aria-hidden="true">
                    {sortIndicator('title')}
                  </span>
                ) : null}
              </th>
              <th
                className="tool-chart-sort-th"
                onClick={() => onSort('time')}
              >
                Time
                {sortIndicator('time') ? (
                  <span className="tool-chart-sort-indicator" aria-hidden="true">
                    {sortIndicator('time')}
                  </span>
                ) : null}
              </th>
              <th
                className="tool-chart-sort-th"
                onClick={() => onSort('score')}
              >
                Score
                {sortIndicator('score') ? (
                  <span className="tool-chart-sort-indicator" aria-hidden="true">
                    {sortIndicator('score')}
                  </span>
                ) : null}
              </th>
              <th>Chart</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              const widthPct =
                maxMinutes > 0 ? Math.max(2, (row.minutes / maxMinutes) * 100) : 0;
              return (
                <tr key={row.entry.mediaId}>
                  <td className="tool-stats-time-chart-title">
                    <ToolShowButton
                      mediaId={row.entry.mediaId}
                      title={row.entry.title}
                      coverImage={row.entry.coverImage}
                      mediaType={row.entry.mediaType}
                      onOpenMedia={onOpenMedia}
                      compact
                    />
                  </td>
                  <td className="tool-stats-time-chart-metric">
                    {formatStatsDuration(row.minutes)}
                  </td>
                  <td className={`tool-stats-time-chart-metric ${statsScoreToneClass(row.entry)}`}>
                    {formatStatsScoreCell(row.entry)}
                  </td>
                  <td className="tool-stats-time-chart-bar-cell">
                    <div className="tool-stats-time-bar-wrap" title={formatStatsDuration(row.minutes)}>
                      <div className="tool-stats-time-bar" style={{ width: `${widthPct}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
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
    <section className="tool-stats-summary">
      <h3>Summary</h3>
      <dl className="tool-stats-summary-grid">
        <div><dt>On list</dt><dd>{summary.onList}</dd></div>
        <div><dt>Rated</dt><dd>{summary.rated}</dd></div>
        <div><dt>Mean score</dt><dd>{StatsMetricCell(summary.meanScore)}</dd></div>
        <div><dt>Weighted mean</dt><dd>{StatsMetricCell(summary.weightedMeanScore)}</dd></div>
        <div><dt>Median</dt><dd>{StatsMetricCell(summary.medianScore)}</dd></div>
        <div><dt>Global difference</dt><dd>{StatsMetricCell(summary.globalDifference)}</dd></div>
        <div><dt>Global deviation</dt><dd>{StatsMetricCell(summary.globalDeviation)}</dd></div>
        <div><dt>Rating entropy</dt><dd>{StatsMetricCell(summary.ratingEntropy)}</dd></div>
        <div>
          <dt>Most common score</dt>
          <dd>
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
          </dd>
        </div>
        <div>
          <dt>Time watched</dt>
          <dd>
            {mediaType === 'ANIME' && summary.timeWatchedMinutes > 0 ? (
              <button
                type="button"
                className="tool-stats-summary-link"
                onClick={onOpenTimeChart}
              >
                {formatStatsDuration(summary.timeWatchedMinutes)}
              </button>
            ) : (
              formatStatsDuration(summary.timeWatchedMinutes)
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function StatsTable({
  title,
  rows,
  mediaType,
  sort,
  onSort,
  showMainOnly,
  showDiff,
  onOpenMedia,
  onOpenStaff,
  expandedKeys,
  onToggleExpand,
}: {
  title: string;
  rows: StatsParentRow[];
  mediaType: StatsForm['mediaType'];
  sort: StatsSortState;
  onSort: (column: StatsSortColumn, backward: boolean) => void;
  showMainOnly: boolean;
  showDiff: boolean;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
  onOpenStaff: ToolPanelProps['onOpenStaff'];
  expandedKeys: Set<string>;
  onToggleExpand: (key: string) => void;
}) {
  const isAnime = mediaType === 'ANIME';
  const columns: { key: StatsSortColumn; label: string }[] = [
    { key: 'name', label: 'Name' },
    { key: 'count', label: 'Count' },
    { key: 'meanScore', label: 'Mean Score' },
    { key: 'anilistMeanScore', label: 'Anilist Score' },
  ];
  if (showMainOnly) {
    columns.push(
      { key: 'mainRoleCount', label: 'Main Role Count' },
      { key: 'mainRoleMeanScore', label: 'Main Role Mean Score' },
      { key: 'mainRoleAnilistMeanScore', label: 'Main Role Anilist Score' },
    );
  }
  if (showDiff) {
    columns.push({ key: 'scoreDiff', label: 'Score Diff' });
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
        ...(showMainOnly
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
      <DragScroll className="tool-stats-table-scroll">
        <table className="tool-stats-table">
          <thead>
            <tr>
              {columns.map((col) => {
                const active = sort?.column === col.key;
                const indicator = active ? (sort?.direction === 'desc' ? '↓' : '↑') : null;
                return (
                  <th
                    key={col.key}
                    className={['tool-chart-sort-th', active ? 'tool-chart-sort-th--active' : ''].filter(Boolean).join(' ')}
                    onClick={(e) => onSort(col.key, e.button === 2)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onSort(col.key, true);
                    }}
                  >
                    {col.label}
                    {indicator ? <span className="tool-chart-sort-indicator" aria-hidden="true">{indicator}</span> : null}
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
                        <ToolStaffButton
                          staffId={row.staffId}
                          name={row.name}
                          imageUrl={row.staffImage ?? undefined}
                          gender={row.staffGender}
                          onOpenStaff={onOpenStaff}
                          compact
                        />
                      ) : (
                        <span className={row.isNonAnimationStudio ? 'text-muted' : undefined}>{row.name}</span>
                      )}
                    </td>
                    <td>{row.metrics.count}</td>
                    <td>{StatsMetricCell(row.metrics.meanScore)}</td>
                    <td>{StatsMetricCell(row.metrics.anilistMeanScore)}</td>
                    {showMainOnly ? (
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
                          showMainOnly={showMainOnly}
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
    </section>
  );
}

function StatsSubrowTr({
  sub,
  showMainOnly,
  showDiff,
  isAnime,
  onOpenMedia,
}: {
  sub: StatsSubrow;
  showMainOnly: boolean;
  showDiff: boolean;
  isAnime: boolean;
  onOpenMedia: ToolPanelProps['onOpenMedia'];
}) {
  const entry = sub.entry;
  return (
    <tr className="tool-stats-subrow">
      <td className="tool-stats-name-cell">
        <StatsSubrowNameCell entry={entry} link={sub.link} onOpenMedia={onOpenMedia} />
      </td>
      <td>1</td>
      <td className={statsScoreToneClass(entry)}>{formatStatsScoreCell(entry)}</td>
      <td>{entry.meanScore ?? '—'}</td>
      {showMainOnly ? <td colSpan={3}>—</td> : null}
      {showDiff ? <td>—</td> : null}
      {isAnime ? (
        <>
          <td>{entry.progress}</td>
          <td>{formatStatsDuration((entry.duration ?? 1) * (entry.progress ?? 0))}</td>
          <td>—</td>
          <td>—</td>
        </>
      ) : (
        <>
          <td>{entry.progress}</td>
          <td>—</td>
          <td>{entry.progressVolumes ?? 0}</td>
          <td>—</td>
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
  const [sort, setSort] = useState<StatsSortState>(null);
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
        const fetchOptions = {
          forceRefresh: options?.forceRefresh,
          expandCast: options?.expandCast,
          onProgress: setProgress,
          signal: controller.signal,
        };
        const data = await fetchStatsData(username, form.mediaType, fetchOptions);
        if (controller.signal.aborted) {
          return;
        }
        if (options?.expandCast && !options.forceRefresh) {
          const expanded = await expandStatsCast(data, fetchOptions);
          if (controller.signal.aborted) {
            return;
          }
          setCached(expanded);
        } else {
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
  }, []);

  const onRun = useCallback(
    (forceRefresh = false) => {
      void runFetch({ forceRefresh, expandCast: form.aggregationType === 'STAFF' || form.aggregationType === 'VA' });
    },
    [form.aggregationType, runFetch],
  );

  const onExpandCast = useCallback(() => {
    if (!cached) {
      void runFetch({ expandCast: true });
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

  const displayCached = useMemo(() => {
    if (!cached) {
      return null;
    }
    return relabelStatsEntries(cached);
  }, [cached, displayLabelRevision]);

  const built = useMemo(() => {
    if (!displayCached) {
      return null;
    }
    return buildStatsResult(displayCached.entries, form);
  }, [displayCached, form]);

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

  const sortedStaffRows = useMemo(
    () => (built ? sortStatsRows(built.staffRows, sort) : []),
    [built, sort],
  );
  const sortedVaRows = useMemo(
    () => (built ? sortStatsRows(built.vaRows, sort) : []),
    [built, sort],
  );
  const sortedGenreRows = useMemo(
    () => (built ? sortStatsRows(built.genreRows, sort) : []),
    [built, sort],
  );
  const sortedTagRows = useMemo(
    () => (built ? sortStatsRows(built.tagRows, sort) : []),
    [built, sort],
  );
  const sortedCustomTagRows = useMemo(
    () => (built ? sortStatsRows(built.customTagRows, sort) : []),
    [built, sort],
  );
  const sortedStudioRows = useMemo(
    () => (built ? sortStatsRows(built.studioRows, sort) : []),
    [built, sort],
  );

  const onSort = useCallback((column: StatsSortColumn, backward: boolean) => {
    setSort((prev) => cycleStatsSort(prev, column, backward));
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

  const listStatusOptions = useMemo(() => {
    if (form.aggregationType === 'STAFF' || form.aggregationType === 'VA') {
      return STATS_LIST_STATUS_OPTIONS.filter((s) => s !== 'PLANNING');
    }
    return [...STATS_LIST_STATUS_OPTIONS];
  }, [form.aggregationType]);

  const aggregationOptions = availableStatsAggregationTypes(form.mediaType);
  const staffRoleOptions =
    form.mediaType === 'MANGA' ? statsMangaStaffRoleOptions() : statsAnimeStaffRoleOptions();

  return (
    <section className="tool-panel tool-stats-panel">
      <p className="tool-panel-lead">
        Aggregate list statistics by voice actor, staff, genres, tags, or studios — inspired by
        Automail&apos;s More Stats.
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
          <StatsToggleChip
            label="User Stats Summary"
            active={form.showSummary}
            disabled={running}
            onToggle={() => patchForm({ showSummary: !form.showSummary })}
            title="Show AniList-style summary totals for the filtered pool"
          />
        </div>

        <div className="tool-adaptation-primary-filters tool-seasonal-primary-filters">
          <ToolSegmentedFilter
            label="Media type"
            options={STATS_MEDIA_TYPE_OPTIONS}
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

          <MultiSelectChip
            label="list status"
            options={listStatusOptions}
            selected={form.listStatusFilters.filter((s) => listStatusOptions.includes(s))}
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
        </div>

        <div className="tool-adaptation-primary-filters tool-seasonal-primary-filters tool-stats-type-filters">
          <ToolSegmentedFilter
            label="Type"
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
                label="Main Only"
                active={form.vaMainOnly}
                disabled={running}
                onToggle={() => patchForm({ vaMainOnly: !form.vaMainOnly })}
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
              onChange={(patch) =>
                patchForm({
                  tagOptions: {
                    ...form.tagOptions,
                    ...(patch.tagMode != null ? { tagMode: patch.tagMode } : {}),
                    ...(patch.tagMinRank != null ? { tagMinRank: patch.tagMinRank } : {}),
                  },
                })
              }
            />
          ) : null}

          {form.aggregationType === 'STUDIOS' ? (
            <MultiSelectChip
              label="studio kind"
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
            <button type="button" className="btn" disabled={running} onClick={onExpandCast}>
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
        {error && <p className="tool-error">{error}</p>}
      </form>

      {built && (
        <div className="tool-chart-fullbleed">
          {built.summary && (
            <StatsSummarySection
              summary={built.summary}
              mediaType={form.mediaType}
              onOpenScoreList={() => setSummaryModal('score-list')}
              onOpenTimeChart={() => setSummaryModal('time-chart')}
            />
          )}

          {form.aggregationType === 'STAFF' && (
            <StatsTable
              title="Staff"
              rows={sortedStaffRows}
              mediaType={form.mediaType}
              sort={sort}
              onSort={onSort}
              showMainOnly={false}
              showDiff={false}
              onOpenMedia={onOpenMedia}
              onOpenStaff={onOpenStaff}
              expandedKeys={expandedKeys}
              onToggleExpand={onToggleExpand}
            />
          )}

          {form.aggregationType === 'VA' && (
            <StatsTable
              title="Voice Actors"
              rows={sortedVaRows}
              mediaType={form.mediaType}
              sort={sort}
              onSort={onSort}
              showMainOnly={form.vaMainOnly}
              showDiff={form.vaShowDiff}
              onOpenMedia={onOpenMedia}
              onOpenStaff={onOpenStaff}
              expandedKeys={expandedKeys}
              onToggleExpand={onToggleExpand}
            />
          )}

          {form.aggregationType === 'GENRES_TAGS' && (
            <>
              <StatsTable
                title="Genres"
                rows={sortedGenreRows}
                mediaType={form.mediaType}
                sort={sort}
                onSort={onSort}
                showMainOnly={false}
                showDiff={false}
                onOpenMedia={onOpenMedia}
                onOpenStaff={onOpenStaff}
                expandedKeys={expandedKeys}
                onToggleExpand={onToggleExpand}
              />
              <StatsTable
                title="AniList Tags"
                rows={sortedTagRows}
                mediaType={form.mediaType}
                sort={sort}
                onSort={onSort}
                showMainOnly={false}
                showDiff={false}
                onOpenMedia={onOpenMedia}
                onOpenStaff={onOpenStaff}
                expandedKeys={expandedKeys}
                onToggleExpand={onToggleExpand}
              />
              <StatsTable
                title="Custom Tags"
                rows={sortedCustomTagRows}
                mediaType={form.mediaType}
                sort={sort}
                onSort={onSort}
                showMainOnly={false}
                showDiff={false}
                onOpenMedia={onOpenMedia}
                onOpenStaff={onOpenStaff}
                expandedKeys={expandedKeys}
                onToggleExpand={onToggleExpand}
              />
            </>
          )}

          {form.aggregationType === 'STUDIOS' && (
            <StatsTable
              title="Studios"
              rows={sortedStudioRows}
              mediaType={form.mediaType}
              sort={sort}
              onSort={onSort}
              showMainOnly={false}
              showDiff={false}
              onOpenMedia={onOpenMedia}
              onOpenStaff={onOpenStaff}
              expandedKeys={expandedKeys}
              onToggleExpand={onToggleExpand}
            />
          )}
        </div>
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
