import { useMemo, useState } from 'react';
import type { Item, SortState } from '../lib/types';
import { AddItemModal } from './AddItemModal';
import { AddPreRankedModal } from './AddPreRankedModal';

interface Props {
  state: SortState;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onReorder: (queueIndex: number, itemIndex: number, dir: -1 | 1) => void;
  onBreakApart: (queueIndex: number) => void;
  onAddItem: (item: Item) => void;
  onAppendPreRanked: (items: Item[]) => void;
}

function Thumb({ item }: { item: Item }) {
  return (
    <span className="thumb">
      {item.imageUrl ? (
        <img src={item.imageUrl} alt="" />
      ) : (
        <span>{item.label.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}

export function ListScreen({
  state,
  onHide,
  onUnhide,
  onReorder,
  onBreakApart,
  onAddItem,
  onAppendPreRanked,
}: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [appendOpen, setAppendOpen] = useState(false);
  const hidden = useMemo(() => new Set(state.hidden), [state.hidden]);
  const existingIds = useMemo(
    () => new Set(Object.keys(state.items)),
    [state.items],
  );

  return (
    <div className="page">
      {state.current && (
        <div className="list-merging">
          <div className="list-section-label">Currently merging</div>
          <CurrentMergeRow
            label="Merged so far"
            ids={state.current.merged}
            state={state}
            hidden={hidden}
            onHide={onHide}
            onUnhide={onUnhide}
          />
          <CurrentMergeRow
            label="Left remaining"
            ids={state.current.left}
            state={state}
            hidden={hidden}
            onHide={onHide}
            onUnhide={onUnhide}
          />
          <CurrentMergeRow
            label="Right remaining"
            ids={state.current.right}
            state={state}
            hidden={hidden}
            onHide={onHide}
            onUnhide={onUnhide}
          />
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              marginTop: 8,
            }}
          >
            Use the RANK tab to make comparisons, or undo to back out of this
            merge.
          </div>
        </div>
      )}

      <div className="list-section-label">
        Queue ({state.queue.length} sublist{state.queue.length === 1 ? '' : 's'})
      </div>
      {state.queue.length === 0 && (
        <div
          className="page-section"
          style={{ textAlign: 'center', color: 'var(--text-muted)' }}
        >
          Queue is empty.
        </div>
      )}
      {state.queue.map((sub, qi) => (
        <SublistView
          key={qi}
          sub={sub}
          queueIndex={qi}
          state={state}
          hidden={hidden}
          onHide={onHide}
          onUnhide={onUnhide}
          onReorder={onReorder}
          onBreakApart={onBreakApart}
        />
      ))}

      <div className="add-buttons">
        <button className="btn" onClick={() => setAddOpen(true)}>
          + Add item
        </button>
        <button className="btn" onClick={() => setAppendOpen(true)}>
          + Add pre-ranked list
        </button>
      </div>

      {addOpen && (
        <AddItemModal
          existingIds={existingIds}
          onCancel={() => setAddOpen(false)}
          onAdd={(item) => {
            onAddItem(item);
            setAddOpen(false);
          }}
        />
      )}
      {appendOpen && (
        <AddPreRankedModal
          onCancel={() => setAppendOpen(false)}
          onAppend={(items) => {
            onAppendPreRanked(items);
            setAppendOpen(false);
          }}
        />
      )}
    </div>
  );
}

function CurrentMergeRow({
  label,
  ids,
  state,
  hidden,
  onHide,
  onUnhide,
}: {
  label: string;
  ids: string[];
  state: SortState;
  hidden: Set<string>;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
}) {
  return (
    <div className="list-merge-row">
      <div className="row-label">{label}</div>
      <div className="list-chip-row">
        {ids.length === 0 && (
          <span style={{ fontSize: 13, color: 'var(--text-faint)' }}>
            (empty)
          </span>
        )}
        {ids.map((id) => {
          const item = state.items[id];
          if (!item) return null;
          const isHidden = hidden.has(id);
          return (
            <span
              key={id}
              className={`chip ${isHidden ? 'hidden' : ''}`}
              title={item.label}
            >
              <Thumb item={item} />
              {item.label}
              {isHidden ? (
                <button
                  className="x"
                  onClick={() => onUnhide(id)}
                  title="Restore item"
                  aria-label={`Restore ${item.label}`}
                >
                  ↺
                </button>
              ) : (
                <button
                  className="x"
                  onClick={() => onHide(id)}
                  title="Remove item"
                  aria-label={`Remove ${item.label}`}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function SublistView({
  sub,
  queueIndex,
  state,
  hidden,
  onHide,
  onUnhide,
  onReorder,
  onBreakApart,
}: {
  sub: string[];
  queueIndex: number;
  state: SortState;
  hidden: Set<string>;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onReorder: (queueIndex: number, itemIndex: number, dir: -1 | 1) => void;
  onBreakApart: (queueIndex: number) => void;
}) {
  const isFront = queueIndex < 2;
  return (
    <div className="queue-sublist">
      <div className="queue-sublist-header">
        <span className="index">
          #{queueIndex + 1}{' '}
          {isFront && state.current === null && queueIndex < 2 && (
            <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>
              · next to merge
            </span>
          )}
        </span>
        {sub.length > 1 && (
          <button
            className="icon-btn break-btn"
            onClick={() => onBreakApart(queueIndex)}
            title="Break this sublist apart into singletons at the end of the queue"
          >
            ⚡ Break apart
          </button>
        )}
      </div>
      <div className="queue-sublist-items">
        {sub.map((id, ii) => {
          const item = state.items[id];
          if (!item) return null;
          const isHidden = hidden.has(id);
          return (
            <div
              key={id}
              className={`queue-item-row ${isHidden ? 'hidden' : ''}`}
            >
              <span className="rank">{ii + 1}.</span>
              <Thumb item={item} />
              <span className="label-cell" title={item.label}>
                {item.label}
              </span>
              <span className="actions">
                {sub.length > 1 && (
                  <>
                    <button
                      className="icon-btn"
                      onClick={() => onReorder(queueIndex, ii, -1)}
                      disabled={ii === 0}
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => onReorder(queueIndex, ii, 1)}
                      disabled={ii === sub.length - 1}
                      title="Move down"
                    >
                      ↓
                    </button>
                  </>
                )}
              </span>
              <span className="actions">
                {isHidden ? (
                  <button
                    className="icon-btn"
                    onClick={() => onUnhide(id)}
                    title="Restore"
                  >
                    ↺
                  </button>
                ) : (
                  <button
                    className="icon-btn danger"
                    onClick={() => onHide(id)}
                    title="Remove"
                  >
                    ×
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
