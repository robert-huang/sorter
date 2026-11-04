import { useState } from 'react';
import type { SectionResortMethod } from '../lib/completedSortEditH';
import type { Item } from '../lib/types';
import { ItemThumb } from './ItemThumb';
import { Modal } from './Modal';

interface Props {
  /** Visible final ranking, top first. */
  ranking: Item[];
  onCancel: () => void;
  /** 0-based inclusive indexes into `ranking`. */
  onStart: (startIndex: number, endIndex: number, method: SectionResortMethod) => void;
}

interface Range {
  start: number;
  end: number;
}

function clampRank(value: number, count: number): number {
  return Math.min(Math.max(Math.round(value), 1), count);
}

/** Click sets a new single-row range; shift-click stretches the current one to the row. */
export function nextRangeForClick(range: Range | null, index: number, extend: boolean): Range {
  if (!extend || range === null) return { start: index, end: index };
  return {
    start: Math.min(range.start, range.end, index),
    end: Math.max(range.start, range.end, index),
  };
}

function RankInput({
  id,
  label,
  value,
  count,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  count: number;
  onChange: (rank: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? '' : String(value));
  return (
    <label className="section-resort-rank" htmlFor={id}>
      {label}
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={shown}
        onChange={(e) => {
          // Only half-typed text is kept locally; a valid rank shows the (clamped) range value.
          const parsed = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(parsed)) {
            setDraft(null);
            onChange(clampRank(parsed, count));
          } else {
            setDraft(e.target.value);
          }
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          setDraft(null);
          const base = value ?? 1;
          onChange(clampRank(base + (e.key === 'ArrowUp' ? 1 : -1), count));
        }}
      />
    </label>
  );
}

export function SectionResortModal({ ranking, onCancel, onStart }: Props) {
  const [range, setRange] = useState<Range | null>(null);
  const count = ranking.length;
  const size = range ? range.end - range.start + 1 : 0;
  const canStart = range !== null && size >= 2;

  const setStartRank = (rank: number): void => {
    const start = rank - 1;
    setRange((r) => ({ start, end: Math.max(start, r?.end ?? start) }));
  };
  const setEndRank = (rank: number): void => {
    const end = rank - 1;
    setRange((r) => ({ start: Math.min(end, r?.start ?? end), end }));
  };

  const start = (method: SectionResortMethod): void => {
    if (!range || !canStart) return;
    onStart(range.start, range.end, method);
  };

  return (
    <Modal label="Re-sort a section" onClose={onCancel} className="modal-section-resort">
      <h3>Re-sort a section</h3>
      <p className="section-resort-hint">
        Pick a range of ranks to sort again. The rest of the list stays where it is.
        Click a row to start the range, shift-click another to extend it.
      </p>
      <div className="section-resort-ranks">
        <RankInput
          id="section-resort-from"
          label="From rank"
          value={range ? range.start + 1 : null}
          count={count}
          onChange={setStartRank}
        />
        <RankInput
          id="section-resort-to"
          label="To rank"
          value={range ? range.end + 1 : null}
          count={count}
          onChange={setEndRank}
        />
      </div>
      <ol className="section-resort-list" aria-label="Ranking">
        {ranking.map((item, i) => {
          const selected = range !== null && i >= range.start && i <= range.end;
          return (
            // A row div, not a button: ItemThumb can render its own detail button.
            <li
              key={item.id}
              role="button"
              tabIndex={0}
              className={`section-resort-row${selected ? ' selected' : ''}`}
              aria-pressed={selected}
              onClick={(e) => setRange((r) => nextRangeForClick(r, i, e.shiftKey))}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                setRange((r) => nextRangeForClick(r, i, e.shiftKey));
              }}
            >
              <span className="section-resort-rank-num">{i + 1}</span>
              <ItemThumb item={item} className="section-resort-thumb" />
              <span className="section-resort-label">{item.label}</span>
            </li>
          );
        })}
      </ol>
      <div className="modal-actions section-resort-footer">
        <span className="section-resort-summary" aria-live="polite">
          {range
            ? `Ranks ${range.start + 1}–${range.end + 1} · ${size} item${size === 1 ? '' : 's'}`
            : 'No range selected'}
          {range && size < 2 ? ' · pick at least 2' : ''}
        </span>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canStart}
          onClick={() => start('confirm')}
          title="Walk the range in its current order; only items that are out of place cost extra comparisons"
        >
          Confirm order
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!canStart}
          onClick={() => start('merge')}
          title="Shuffle the range and merge sort it from scratch"
        >
          Merge sort
        </button>
      </div>
    </Modal>
  );
}
