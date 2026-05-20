import { useEffect, useRef, useState } from 'react';
import type { SlotMeta } from '../lib/types';

interface Props {
  slots: SlotMeta[];
  /**
   * Id of the slot whose blob is currently loaded into memory (i.e. the
   * one the user is sorting in *right now*). Null on START when nothing
   * is loaded. The "Active" tag is shown only for this slot — having a
   * "lastUsed" pointer in the manifest is not enough; we want the tag to
   * mean "you are currently sorting here", not "this was your last
   * session".
   */
  loadedSlotId: string | null;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

/**
 * Loose "X minutes ago" formatter — keeps the slot list compact without a
 * date lib dependency. Falls back to absolute YYYY-MM-DD for anything older
 * than ~6 days.
 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 90) return '1 min ago';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return iso.slice(0, 10);
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function SlotList({
  slots,
  loadedSlotId,
  onSwitch,
  onDelete,
  onRename,
}: Props) {
  if (slots.length === 0) {
    return (
      <div className="slot-list empty">
        <div className="slot-list-empty">No saved sorts yet.</div>
      </div>
    );
  }

  // Most-recently-touched first — matches the "last used" Resume CTA on
  // START and is the order users intuitively expect for a recents list.
  const ordered = slots
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="slot-list">
      <div className="slot-list-header">Saved sorts</div>
      {ordered.map((s) => (
        <SlotRow
          key={s.id}
          slot={s}
          isLoaded={loadedSlotId === s.id}
          onSwitch={onSwitch}
          onDelete={onDelete}
          onRename={onRename}
        />
      ))}
    </div>
  );
}

interface RowProps {
  slot: SlotMeta;
  /** True when this slot's blob is the one loaded into memory right now. */
  isLoaded: boolean;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

function SlotRow({ slot, isLoaded, onSwitch, onDelete, onRename }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slot.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the draft in sync if the slot meta changes underneath us (e.g.
  // autosave updates from another React render path).
  useEffect(() => {
    if (!editing) setDraft(slot.name);
  }, [slot.name, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commitRename(): void {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== slot.name) {
      onRename(slot.id, trimmed);
    } else {
      // Revert visible draft if nothing usable was typed.
      setDraft(slot.name);
    }
  }

  function cancelRename(): void {
    setEditing(false);
    setDraft(slot.name);
  }

  const meta = [
    pluralize(slot.totalItems, 'item'),
    pluralize(slot.comparisons, 'comparison'),
    slot.done ? 'done' : null,
    relativeTime(slot.updatedAt),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`slot-row${isLoaded ? ' active' : ''}`}>
      <div className="slot-row-main">
        {editing ? (
          <input
            ref={inputRef}
            className="slot-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
              }
            }}
          />
        ) : (
          <button
            className="slot-name"
            type="button"
            title="Click to rename"
            onClick={() => setEditing(true)}
          >
            {slot.name}
          </button>
        )}
        <div className="slot-meta">{meta}</div>
      </div>
      <div className="slot-actions">
        {isLoaded ? (
          <span className="slot-active-tag">Active</span>
        ) : (
          <button
            className="btn primary"
            onClick={() => onSwitch(slot.id)}
            title="Switch to this sort"
          >
            Resume
          </button>
        )}
        <button
          className="x-button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(slot.id);
          }}
          title={`Delete ${slot.name}`}
          aria-label={`Delete ${slot.name}`}
        >
          ×
        </button>
      </div>
    </div>
  );
}
