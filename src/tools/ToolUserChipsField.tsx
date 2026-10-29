import { useState, type KeyboardEvent } from 'react';
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
  label?: string;
  inputName?: string;
};

/** Inline list of user chips (refresh + remove) with an add box, shared by multi-user tools. */
export function ToolUserChipsField({
  usernames,
  isLoading,
  onAdd,
  onRemove,
  onRefresh,
  label = 'Users',
  inputName = 'tool-user-chips-username',
}: ToolUserChipsFieldProps) {
  const [text, setText] = useState('');
  const [history, setHistory] = useState<string[]>(loadToolUserHistory);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const suggestions = open ? suggestToolUsers(history, text, usernames) : [];
  const listId = `${inputName}-history`;

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
        {usernames.map((name) => (
          <span key={name.toLowerCase()} className="tool-user-chip">
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
