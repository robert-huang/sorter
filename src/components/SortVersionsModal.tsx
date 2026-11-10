import { useMemo, useState } from 'react';
import {
  DEFAULT_SORT_VERSION_MOVEMENT_MODE,
  diffSortVersions,
  formatSortVersionDate,
  summarizeSortVersionDiff,
  type SortVersionMovementMode,
} from '../lib/sortVersions';
import type { SortVersion } from '../lib/types';
import { Modal } from './Modal';
interface Props {
  /** Oldest first, as stored. */
  versions: readonly SortVersion[];
  movementMode?: SortVersionMovementMode;
  onClose: () => void;
}

function rankChangeLabel(delta: number | undefined, isNew: boolean): string {
  if (isNew) return 'new';
  if (!delta) return '';
  return delta > 0 ? `↑${delta}` : `↓${-delta}`;
}

/**
 * A version's full ranking with changes marked against its predecessor, plus removed items.
 * Rows always show each item's raw rank change. Under the movement mode, changes the
 * summary doesn't count as moves (items that only shifted to make room) are faded.
 */
export function VersionRanking({
  version,
  prev,
  mode = DEFAULT_SORT_VERSION_MOVEMENT_MODE,
}: {
  version: SortVersion;
  prev: SortVersion | null;
  mode?: SortVersionMovementMode;
}) {
  const { moves, movers, added, removed, renamed } = useMemo(() => {
    const diff = diffSortVersions(prev, version, 'raw');
    const counted = mode === 'raw' ? diff : diffSortVersions(prev, version, mode);
    return {
      moves: new Map(diff.moved.map((m) => [m.id, m.delta])),
      movers: new Set(counted.moved.map((m) => m.id)),
      added: new Set(diff.added),
      removed: diff.removed,
      renamed: new Set(diff.renamed),
    };
  }, [prev, version, mode]);
  return (
    <>
    <ol className="sort-version-ranking">
      {version.rankedIds.map((id, i) => {
        const isNew = prev !== null && added.has(id);
        const change = rankChangeLabel(moves.get(id), isNew);
        const delta = moves.get(id) ?? 0;
        return (
          <li key={id} className="sort-version-ranking-row">
            <span className="rank-num">{i + 1}</span>
            <span className="sort-version-ranking-label">{version.items[id]?.label ?? id}</span>
            {change && (
              <span
                className={`sort-version-change${delta > 0 ? ' up' : ''}${delta < 0 ? ' down' : ''}${isNew ? ' new' : ''}${delta && !movers.has(id) ? ' is-shift' : ''}`}
                title={delta && !movers.has(id) ? 'Shifted to make room for other moves' : undefined}
              >
                {change}
              </span>
            )}
            {renamed.has(id) && (
              <span
                className="sort-version-change renamed"
                title={`Was "${prev?.items[id]?.label ?? id}"`}
              >
                renamed
              </span>
            )}
          </li>
        );
      })}
    </ol>
    {prev && removed.length > 0 && (
      <ul className="sort-version-removed" aria-label="Removed since previous version">
        {removed.map((id) => (
          <li key={id} className="sort-version-ranking-row">
            <span className="rank-num">{prev.rankedIds.indexOf(id) + 1}</span>
            <span className="sort-version-ranking-label">{prev.items[id]?.label ?? id}</span>
            <span className="sort-version-change removed">removed</span>
          </li>
        ))}
      </ul>
    )}
    </>
  );
}

/** Read-only history of finished rankings, newest first, each diffed against its direct predecessor. */
export function SortVersionsModal({
  versions,
  movementMode = DEFAULT_SORT_VERSION_MOVEMENT_MODE,
  onClose,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      versions
        .map((version, i) => ({ version, prev: i > 0 ? versions[i - 1] : null }))
        .reverse(),
    [versions],
  );
  return (
    <Modal label="Sort versions" onClose={onClose} className="modal-wide">
      <h3>Versions</h3>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
        Versions are kept when this sort finishes with a different order and when you press
        Save version. The Current version follows edits to the finished ranking and updates
        when you stop editing, such as switching tabs or slots or leaving the page.
      </p>
      <ul className="sort-versions-list">
        {rows.map(({ version, prev }) => {
          const expanded = expandedId === version.id;
          const date = formatSortVersionDate(version.createdAt, true);
          const summary = summarizeSortVersionDiff(prev, version, movementMode);
          return (
            <li key={version.id} className="sort-versions-row">
              <div className="sort-versions-row-head">
                <button
                  type="button"
                  className="sort-versions-toggle"
                  aria-expanded={expanded}
                  title={summary}
                  onClick={() => setExpandedId(expanded ? null : version.id)}
                >
                  <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                  <span
                    className={`sort-versions-date${version.name ? ' is-named' : ''}`}
                    title={version.name ? date : undefined}
                  >
                    {version.name || date}
                  </span>
                  <span className="sort-versions-summary">{summary}</span>
                  {version.live && <span className="sort-versions-current">Current</span>}
                  <span className="sort-versions-count">
                    {version.rankedIds.length} item{version.rankedIds.length === 1 ? '' : 's'}
                  </span>
                </button>
              </div>
              {expanded && (
                <VersionRanking version={version} prev={prev} mode={movementMode} />
              )}
            </li>
          );
        })}
      </ul>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
