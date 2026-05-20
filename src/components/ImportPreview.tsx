import { useMemo, useState } from 'react';
import type { DedupWarning } from '../lib/types';
import type { PreviewItem } from '../lib/csv';

export interface PreviewSource {
  sourceName: string;
  /**
   * Deduped items for this source, in the original row order. Each
   * entry also carries the originating `sourceRow` so the per-row
   * Edit button can call back with a row identifier the parent can
   * resolve to a RawRow.
   */
  items: PreviewItem[];
}

interface Props {
  sources: PreviewSource[];
  totalItems: number;
  warnings: DedupWarning[];
  startLabel: string;
  startDisabled: boolean;
  onStart: () => void;
  /** Sublist count for the totals row; for the scratch mode this is just one. */
  sublistCount?: number;
  singletonCount?: number;
  /**
   * Optional callback for the Edit buttons in the preview. The same
   * handler powers BOTH the per-row pencil in `SourceBlock` (rename
   * any row) AND the per-occurrence Edit button inside a dedup
   * warning (disambiguate a collision). Called with the source name
   * + 1-indexed row number of the originating RawRow + the
   * post-override label so the modal can pre-fill with the user's
   * current state, not the original source text.
   */
  onEditOccurrence?: (
    sourceName: string,
    rowNumber: number,
    currentLabel: string,
  ) => void;
}

export function ImportPreview({
  sources,
  totalItems,
  warnings,
  startLabel,
  startDisabled,
  onStart,
  sublistCount,
  singletonCount,
  onEditOccurrence,
}: Props) {
  if (sources.length === 0) return null;
  const totalsText = useMemo(() => {
    if (sublistCount !== undefined && singletonCount !== undefined) {
      return `Total: ${totalItems} unique item${totalItems === 1 ? '' : 's'} across ${sublistCount} sublist${sublistCount === 1 ? '' : 's'} + ${singletonCount} singleton${singletonCount === 1 ? '' : 's'}`;
    }
    return `Total: ${totalItems} unique item${totalItems === 1 ? '' : 's'}`;
  }, [totalItems, sublistCount, singletonCount]);

  return (
    <div className="preview">
      {sources.map((src) => (
        <SourceBlock
          key={src.sourceName}
          source={src}
          onEditRow={onEditOccurrence}
        />
      ))}
      <div className="preview-totals">{totalsText}</div>
      {warnings.length > 0 && (
        <div className="preview-warnings">
          <strong>Warnings ({warnings.length})</strong>
          <ul>
            {warnings.map((w) => (
              <WarningItem
                key={w.canonicalKey}
                warning={w}
                onEditOccurrence={onEditOccurrence}
              />
            ))}
          </ul>
        </div>
      )}
      <div className="preview-start-row">
        <button
          className="btn primary"
          onClick={onStart}
          disabled={startDisabled}
        >
          {startLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * One row of the warnings list. Renders a one-line summary, then a
 * per-occurrence sub-list with an [Edit label] button against each
 * row. Editing a row opens a modal in StartScreen that writes back to
 * the overlay map; the preview re-derives on the next render and the
 * warning either disappears or updates to reflect the remaining
 * duplicates.
 */
function WarningItem({
  warning: w,
  onEditOccurrence,
}: {
  warning: DedupWarning;
  onEditOccurrence?: (
    sourceName: string,
    rowNumber: number,
    currentLabel: string,
  ) => void;
}) {
  const filled =
    w.mergedFromSources.url || w.mergedFromSources.image ? (
      <>
        {' '}Filled in{' '}
        {[
          w.mergedFromSources.url && `URL from ${w.mergedFromSources.url}`,
          w.mergedFromSources.image && `IMAGE from ${w.mergedFromSources.image}`,
        ]
          .filter(Boolean)
          .join(' and ')}
        .
      </>
    ) : null;

  return (
    <li>
      <div>
        <strong>{w.displayLabel}</strong> appeared in{' '}
        {w.occurrences.length} row{w.occurrences.length === 1 ? '' : 's'}. Kept
        position from {w.winningSource} (row {w.winningRow}).{filled}
      </div>
      {onEditOccurrence && (
        <ul className="warning-occurrences">
          {w.occurrences.map((o) => {
            const isWinner =
              o.sourceName === w.winningSource && o.rowNumber === w.winningRow;
            return (
              <li key={`${o.sourceName}:${o.rowNumber}`}>
                <span>
                  {o.sourceName} (row {o.rowNumber})
                  {isWinner && (
                    <span className="warning-winner-tag"> · kept</span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    onEditOccurrence(o.sourceName, o.rowNumber, w.displayLabel)
                  }
                  title="Rename this row to disambiguate it from the others"
                >
                  Edit label
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function SourceBlock({
  source,
  onEditRow,
}: {
  source: PreviewSource;
  /**
   * Optional click handler for the per-row pencil button. When
   * undefined the pencil is hidden — keeps the preview read-only in
   * contexts that don't wire an edit overlay.
   */
  onEditRow?: (
    sourceName: string,
    rowNumber: number,
    currentLabel: string,
  ) => void;
}) {
  const initiallyOpen = source.items.length <= 10;
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="preview-source">
      <button
        className="preview-source-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span>{source.sourceName}</span>
        <span className="count">
          {source.items.length} item{source.items.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <ul className="preview-items">
          {source.items.map((pi, i) => {
            const it = pi.item;
            return (
              <li key={it.id}>
                <span className="rank">{i + 1}.</span>
                <span className="preview-item-label" title={it.label}>
                  {it.label}
                </span>
                <span className="icons">
                  {it.url && <span title={it.url}>🔗</span>}{' '}
                  {it.imageUrl && <span title={it.imageUrl}>🖼</span>}
                </span>
                {onEditRow && (
                  <button
                    type="button"
                    className="preview-item-edit"
                    onClick={() =>
                      onEditRow(source.sourceName, pi.sourceRow, it.label)
                    }
                    title={`Edit "${it.label}" (row ${pi.sourceRow})`}
                    aria-label={`Edit ${it.label}`}
                  >
                    ✎
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
