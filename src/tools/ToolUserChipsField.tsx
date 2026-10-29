import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { CircularArrowGlyph } from '../components/CircularArrowGlyph';
import { RemoveGlyph } from '../components/RemoveGlyph';
import {
  forgetToolUser,
  loadToolUserHistory,
  rememberToolUser,
  suggestToolUsers,
} from './toolUserHistory';

type ToolUserChipsFieldProps = {
  usernames: readonly string[];
  isLoading: (username: string) => boolean;
  onAdd: (username: string) => void;
  onRemove: (username: string) => void;
  onRefresh: (username: string) => void;
  /** When set, chips can be dragged to reorder; receives the full new order. */
  onReorder?: (usernames: string[]) => void;
  label?: string;
  inputName?: string;
};

/**
 * Moves `from` to the gap `insertAt` (0..length, in pre-move indexes).
 * e.g. moveToGap(['a', 'b', 'c'], 0, 2) → ['b', 'a', 'c'].
 */
export function moveToGap<T>(items: readonly T[], from: number, insertAt: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(insertAt > from ? insertAt - 1 : insertAt, 0, moved);
  return next;
}

function dropGap(e: DragEvent<HTMLElement>, index: number): number {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientX < rect.left + rect.width / 2 ? index : index + 1;
}

/** Inline list of user chips (refresh + remove) with an add box, shared by multi-user tools. */
export function ToolUserChipsField({
  usernames,
  isLoading,
  onAdd,
  onRemove,
  onRefresh,
  onReorder,
  label = 'Users',
  inputName = 'tool-user-chips-username',
}: ToolUserChipsFieldProps) {
  const [text, setText] = useState('');
  const [drag, setDrag] = useState<{ from: number; gap: number | null } | null>(null);
  const [history, setHistory] = useState<string[]>(loadToolUserHistory);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const suggestions = open ? suggestToolUsers(history, text, usernames) : [];
  const listId = `${inputName}-history`;
  const reorderable = Boolean(onReorder) && usernames.length > 1;
  // Gaps on either side of the dragged chip wouldn't move it, so they show no marker.
  const activeGap = drag && drag.gap !== drag.from && drag.gap !== drag.from + 1 ? drag.gap : null;

  const chipClassName = (index: number): string => {
    const classes = ['tool-user-chip'];
    if (drag?.from === index) classes.push('dragging');
    if (activeGap === index) classes.push('drop-before');
    if (activeGap === usernames.length && index === usernames.length - 1) classes.push('drop-after');
    return classes.join(' ');
  };
  const finishDrag = (gap: number) => {
    if (drag && onReorder && gap !== drag.from && gap !== drag.from + 1) {
      onReorder(moveToGap(usernames, drag.from, gap));
    }
    setDrag(null);
  };

  const add = (name: string) => {
    const handle = name.trim();
    if (!handle) return;
    onAdd(handle);
    setHistory(rememberToolUser(handle));
    setText('');
    setActive(-1);
  };
  const forget = (name: string) => {
    const next = forgetToolUser(name);
    setHistory(next);
    const remaining = suggestToolUsers(next, text, usernames).length;
    setActive((i) => Math.min(i, remaining - 1));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const highlighted = active >= 0 ? suggestions[active] : undefined;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (suggestions.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(highlighted ?? text);
    } else if (e.key === 'Delete' && e.shiftKey && highlighted) {
      e.preventDefault();
      forget(highlighted);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };
  return (
    <div className="tool-field tool-field-label-row tool-user-chips-field">
      <span className="tool-field-label">{label}</span>
      <div className="tool-user-chips">
        {usernames.map((name, index) => (
          <span
            key={name.toLowerCase()}
            className={chipClassName(index)}
            draggable={reorderable}
            title={reorderable ? 'Drag to reorder' : undefined}
            onDragStart={
              reorderable
                ? (e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', name);
                    setDrag({ from: index, gap: null });
                  }
                : undefined
            }
            onDragOver={
              drag
                ? (e) => {
                    e.preventDefault();
                    const gap = dropGap(e, index);
                    if (gap !== drag.gap) setDrag({ ...drag, gap });
                  }
                : undefined
            }
            onDrop={
              drag
                ? (e) => {
                    e.preventDefault();
                    finishDrag(dropGap(e, index));
                  }
                : undefined
            }
            onDragEnd={() => setDrag(null)}
          >
            {name}
            <button
              type="button"
              className="btn icon-only tool-user-chip-refresh"
              disabled={isLoading(name)}
              onClick={() => onRefresh(name)}
              title={`Refresh ${name}'s list from AniList`}
              aria-label={`Refresh ${name}'s list from AniList`}
            >
              <CircularArrowGlyph />
            </button>
            <button
              type="button"
              className="tool-user-chip-remove"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              onClick={() => onRemove(name)}
            >
              <RemoveGlyph size={10} />
            </button>
          </span>
        ))}
        <span className="tool-user-history-anchor">
          <input
            className="slot-search tool-username-input"
            type="text"
            name={inputName}
            aria-label="AniList username to compare"
            placeholder="AL Username"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => {
              setHistory(loadToolUserHistory());
              setOpen(true);
            }}
            onBlur={() => {
              setOpen(false);
              setActive(-1);
            }}
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            spellCheck={false}
            autoComplete="one-time-code"
            data-1p-ignore
            data-lpignore="true"
          />
          {suggestions.length > 0 && (
            <ul id={listId} className="tool-user-history" role="listbox" aria-label="Previous users">
              {suggestions.map((name, i) => (
                <li
                  key={name.toLowerCase()}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'tool-user-history-option active' : 'tool-user-history-option'}
                  title="Shift+Delete to forget"
                  // Keep focus in the input so the list doesn't close before the click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => add(name)}
                >
                  {name}
                </li>
              ))}
            </ul>
          )}
        </span>
        <button type="button" className="btn small" disabled={!text.trim()} onClick={() => add(text)}>
          Add
        </button>
      </div>
    </div>
  );
}
