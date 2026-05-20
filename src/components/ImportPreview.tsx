import { useMemo, useState } from 'react';
import type { DedupWarning, Item } from '../lib/types';

export interface PreviewSource {
  sourceName: string;
  items: Item[];
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
        <SourceBlock key={src.sourceName} source={src} />
      ))}
      <div className="preview-totals">{totalsText}</div>
      {warnings.length > 0 && (
        <div className="preview-warnings">
          <strong>Warnings ({warnings.length})</strong>
          <ul>
            {warnings.map((w) => (
              <li key={w.canonicalKey}>
                <strong>{w.displayLabel}</strong> appeared in{' '}
                {w.occurrences
                  .map((o) => `${o.sourceName} (row ${o.rowNumber})`)
                  .join(', ')}
                {'. '}Kept position from {w.winningSource} (row {w.winningRow}).
                {(w.mergedFromSources.url || w.mergedFromSources.image) && (
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
                )}
              </li>
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

function SourceBlock({ source }: { source: PreviewSource }) {
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
          {source.items.map((it, i) => (
            <li key={it.id}>
              <span className="rank">{i + 1}.</span>
              <span title={it.label}>{it.label}</span>
              <span className="icons">
                {it.url && <span title={it.url}>🔗</span>}{' '}
                {it.imageUrl && <span title={it.imageUrl}>🖼</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
