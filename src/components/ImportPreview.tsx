import { useMemo, useState } from 'react';
import type { CommaInLabelWarning, DedupWarning, ExtraColumnsWarning } from '../lib/types';
import type { PreviewItem } from '../lib/csv';
import {
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../lib/importers/anilist/anilistLinks';
import { canOpenItemDetail } from './itemDetailContext';
import { DetailButtonSlot } from './DetailButton';
import { RemoveGlyph } from './RemoveGlyph';

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
  /**
   * Soft warnings for rows that parsed into MORE than the expected 3
   * non-empty cells — almost always an unquoted comma in the label.
   * Rendered as the FIRST entries in the Warnings panel because they
   * indicate potential silent data loss (the URL/image columns may
   * have been hijacked by label fragments) and the user should fix
   * them before starting the session, after which the rawCells are
   * dropped and recovery is no longer possible without re-importing.
   */
  extraColumns?: ExtraColumnsWarning[];
  /**
   * Soft warnings for rows auto-repaired when commas split a title into
   * multiple cells but no trailing cell looked like a URL. Rendered
   * after extraColumns and before dedup warnings.
   */
  commaInLabel?: CommaInLabelWarning[];
  startLabel: string;
  startDisabled: boolean;
  onStart: () => void;
  /** Sublist count for the totals row; for the scratch mode this is just one. */
  sublistCount?: number;
  singletonCount?: number;
  /**
   * Optional callback for the Edit buttons in the preview. The same
   * handler powers BOTH the per-row pencil in `SourceBlock` (rename
   * any row), the per-occurrence Edit button inside a dedup warning
   * (disambiguate a collision), AND the Edit button on an
   * ExtraColumnsWarning (open the row so the user can copy the right
   * substrings out of the original-row panel). Called with the source
   * name + 1-indexed row number of the originating RawRow + the
   * post-override label so the modal can pre-fill with the user's
   * current state, not the original source text.
   */
  onEditOccurrence?: (
    sourceName: string,
    rowNumber: number,
    currentLabel: string,
  ) => void;
  /** Drop a previewed row (and same-id duplicates in that source) from import. */
  onRemoveRow?: (sourceName: string, rowNumber: number) => void;
}

export function ImportPreview({
  sources,
  totalItems,
  warnings,
  extraColumns,
  commaInLabel,
  startLabel,
  startDisabled,
  onStart,
  sublistCount,
  singletonCount,
  onEditOccurrence,
  onRemoveRow,
}: Props) {
  if (sources.length === 0) return null;
  const totalsText = useMemo(() => {
    if (sublistCount !== undefined && singletonCount !== undefined) {
      return `Total: ${totalItems} unique item${totalItems === 1 ? '' : 's'} across ${sublistCount} sublist${sublistCount === 1 ? '' : 's'} + ${singletonCount} singleton${singletonCount === 1 ? '' : 's'}`;
    }
    return `Total: ${totalItems} unique item${totalItems === 1 ? '' : 's'}`;
  }, [totalItems, sublistCount, singletonCount]);

  const extras = extraColumns ?? [];
  const commaRepairs = commaInLabel ?? [];
  const totalWarnings = extras.length + commaRepairs.length + warnings.length;

  return (
    <div className="preview">
      {sources.map((src) => (
        <SourceBlock
          key={src.sourceName}
          source={src}
          onEditRow={onEditOccurrence}
          onRemoveRow={onRemoveRow}
        />
      ))}
      <div className="preview-totals">{totalsText}</div>
      {totalWarnings > 0 && (
        <div className="preview-warnings">
          <strong>Warnings ({totalWarnings})</strong>
          <ul>
            {extras.map((w) => (
              <ExtraColumnsWarningItem
                key={`extra:${w.sourceName}:${w.rowNumber}`}
                warning={w}
                onEditOccurrence={onEditOccurrence}
              />
            ))}
            {commaRepairs.map((w) => (
              <CommaInLabelWarningItem
                key={`comma:${w.sourceName}:${w.rowNumber}`}
                warning={w}
                onEditOccurrence={onEditOccurrence}
              />
            ))}
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
 * One row of the warnings list for an `ExtraColumnsWarning`. Displays
 * the source/row reference, what we *did* parse into label/url/image,
 * and offers an "Edit row" button that opens EditItemModal. The modal
 * receives the row's `rawCells` via the parent's overlay map and shows
 * an "Original row" panel so the user can copy the right substrings
 * into the right fields. We deliberately do NOT block the import here
 * — the warning is advisory.
 */
function ExtraColumnsWarningItem({
  warning,
  onEditOccurrence,
}: {
  warning: ExtraColumnsWarning;
  onEditOccurrence?: (
    sourceName: string,
    rowNumber: number,
    currentLabel: string,
  ) => void;
}) {
  return (
    <li>
      <div>
        <strong>{warning.parsedAs.label}</strong>{' '}
        <span className="extra-cols-meta">
          ({warning.sourceName}, row {warning.rowNumber}) parsed{' '}
          {warning.cellCount} non-empty columns. Likely an unquoted comma
          in the label — verify the URL / image columns aren't holding
          fragments of the label.
        </span>
      </div>
      {onEditOccurrence && (
        <ul className="warning-occurrences">
          <li>
            <span>
              {warning.sourceName} (row {warning.rowNumber})
            </span>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                onEditOccurrence(
                  warning.sourceName,
                  warning.rowNumber,
                  warning.parsedAs.label,
                )
              }
              title="Open this row in the edit modal — the original row is shown so you can copy the right substrings into the right fields"
            >
              Edit row
            </button>
          </li>
        </ul>
      )}
    </li>
  );
}

/**
 * One row of the warnings list for a `CommaInLabelWarning`. The row was
 * auto-repaired by joining comma-split cells into one label; advisory
 * only — import proceeds with the repaired label.
 */
function CommaInLabelWarningItem({
  warning,
  onEditOccurrence,
}: {
  warning: CommaInLabelWarning;
  onEditOccurrence?: (
    sourceName: string,
    rowNumber: number,
    currentLabel: string,
  ) => void;
}) {
  const naive = warning.naiveParsedAs;
  const naiveParts = [
    `label "${naive.label}"`,
    naive.url !== undefined && `url "${naive.url}"`,
    naive.imageUrl !== undefined && `image "${naive.imageUrl}"`,
  ].filter(Boolean);

  return (
    <li>
      <div>
        <strong>{warning.repairedLabel}</strong>{' '}
        <span className="extra-cols-meta">
          ({warning.sourceName}, row {warning.rowNumber}) — joined{' '}
          {warning.cellCount} column{warning.cellCount === 1 ? '' : 's'} into
          one title (no URL detected).
          {naiveParts.length > 0 && (
            <>
              {' '}
              Would have been: {naiveParts.join(', ')}.
            </>
          )}
        </span>
      </div>
      {onEditOccurrence && (
        <ul className="warning-occurrences">
          <li>
            <span>
              {warning.sourceName} (row {warning.rowNumber})
            </span>
            <button
              type="button"
              className="btn small"
              onClick={() =>
                onEditOccurrence(
                  warning.sourceName,
                  warning.rowNumber,
                  warning.repairedLabel,
                )
              }
              title="Open this row in the edit modal — the original row is shown so you can verify or fix the joined title"
            >
              Edit row
            </button>
          </li>
        </ul>
      )}
    </li>
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
  onRemoveRow,
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
  onRemoveRow?: (sourceName: string, rowNumber: number) => void;
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
                <span className="preview-item-trailing">
                  {(it.url || it.imageUrl) && (
                    <span className="preview-item-indicators">
                      {it.url && (
                        <PreviewItemIndicator href={it.url} kind="url" />
                      )}
                      {it.imageUrl && (
                        <PreviewItemIndicator href={it.imageUrl} kind="image" />
                      )}
                    </span>
                  )}
                  {(onEditRow || onRemoveRow || canOpenItemDetail(it)) && (
                    <span className="preview-item-actions">
                      <DetailButtonSlot item={it} variant="row" />
                      {onEditRow && (
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() =>
                            onEditRow(source.sourceName, pi.sourceRow, it.label)
                          }
                          title={`Edit "${it.label}" (row ${pi.sourceRow})`}
                          aria-label={`Edit ${it.label}`}
                        >
                          ✎
                        </button>
                      )}
                      {onRemoveRow && (
                        <button
                          type="button"
                          className="icon-btn danger"
                          onClick={() =>
                            onRemoveRow(source.sourceName, pi.sourceRow)
                          }
                          title={`Remove "${it.label}" from import`}
                          aria-label={`Remove ${it.label}`}
                        >
                          <RemoveGlyph />
                        </button>
                      )}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PreviewItemIndicator({
  href,
  kind,
}: {
  href: string;
  kind: 'url' | 'image';
}) {
  const link = bindAnilistMiddleClick(href);
  const label = kind === 'url' ? 'URL' : 'Image';
  return (
    <span
      className={mergeAnilistLinkClass('preview-item-indicator', link.className)}
      title={`${href} (middle-click to open)`}
      aria-label={`${label} for this row (middle-click to open)`}
      onMouseDown={link.onMouseDown}
      onAuxClick={link.onAuxClick}
      onClick={(e) => e.stopPropagation()}
    >
      {kind === 'url' ? '🔗' : '🖼'}
    </span>
  );
}
