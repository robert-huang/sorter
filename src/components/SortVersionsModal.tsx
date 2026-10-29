import { useMemo, useState } from 'react';
import {
  diffSortVersions,
  formatSortVersionDate,
  summarizeSortVersionDiff,
} from '../lib/sortVersions';
import type { SortVersion } from '../lib/types';
import { Modal } from './Modal';
import { RemoveGlyph } from './RemoveGlyph';

interface Props {
  /** Oldest first, as stored. */
  versions: readonly SortVersion[];
  onDelete: (id: string) => void;
  onClose: () => void;
}

function rankChangeLabel(delta: number | undefined, isNew: boolean): string {
  if (isNew) return 'new';
  if (!delta) return '';
  return delta > 0 ? `↑${delta}` : `↓${-delta}`;
}

/** A version's full ranking with changes marked against its predecessor, plus removed items. */
export function VersionRanking({ version, prev }: { version: SortVersion; prev: SortVersion | null }) {
  const { moves, added, removed } = useMemo(() => {
    const diff = diffSortVersions(prev, version);
    return {
      moves: new Map(diff.moved.map((m) => [m.id, m.delta])),
      added: new Set(diff.added),
      removed: diff.removed,
    };
  }, [prev, version]);
  return (
    <>
    <ol className="sort-version-ranking">
      {version.rankedIds.map((id, i) => {
        const change = rankChangeLabel(moves.get(id), prev !== null && added.has(id));
        const delta = moves.get(id) ?? 0;
        return (
          <li key={id} className="sort-version-ranking-row">
            <span className="rank-num">{i + 1}</span>
            <span className="sort-version-ranking-label">{version.items[id]?.label ?? id}</span>
            {change && (
              <span
                className={`sort-version-change${delta > 0 ? ' up' : ''}${delta < 0 ? ' down' : ''}`}
              >
                {change}
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
export function SortVersionsModal({ versions, onDelete, onClose }: Props) {
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
          return (
            <li key={version.id} className="sort-versions-row">
              <div className="sort-versions-row-head">
                <button
                  type="button"
                  className="sort-versions-toggle"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : version.id)}
                >
                  <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                  <span className="sort-versions-date">{date}</span>
                  {version.live && <span className="sort-versions-current">Current</span>}
                  <span className="sort-versions-count">
                    {version.rankedIds.length} item{version.rankedIds.length === 1 ? '' : 's'}
                  </span>
                  <span className="sort-versions-summary">
                    {summarizeSortVersionDiff(prev, version)}
                  </span>
                </button>
                {!version.live && (
                  <button
                    type="button"
                    className="btn icon-only sort-versions-delete"
                    aria-label={`Delete version from ${date}`}
                    title="Delete this version"
                    onClick={() => {
                      if (expanded) setExpandedId(null);
                      onDelete(version.id);
                    }}
                  >
                    <RemoveGlyph size={12} />
                  </button>
                )}
              </div>
              {expanded && <VersionRanking version={version} prev={prev} />}
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
