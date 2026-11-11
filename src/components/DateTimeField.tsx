import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { formatDateTimeLocal, parseDateTimeText } from '../lib/dateTimeText';

interface Props {
  /** `datetime-local` value, e.g. `2026-01-05T14:30`. */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Date for january". */
  label: string;
  disabled?: boolean;
  /** Shows only the day until clicked; the editor still takes the full date and time. */
  compact?: boolean;
}

/**
 * Date/time shown as text; clicking edits it as text with a native picker underneath.
 * Typed text is only saved when it parses; a date alone means midnight.
 */
export function DateTimeField({ value, onChange, label, disabled = false, compact = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const invalid = editing && parseDateTimeText(text) === null;

  const open = (): void => {
    setText(formatDateTimeLocal(value));
    setEditing(true);
  };

  const commitText = (): void => {
    const parsed = parseDateTimeText(text);
    if (parsed !== null && parsed !== value) onChange(parsed);
    setEditing(false);
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (wrapperRef.current?.contains(e.relatedTarget as Node | null)) return;
    commitText();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitText();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    }
  };

  if (!editing) {
    const full = formatDateTimeLocal(value);
    return (
      <button
        type="button"
        className={`date-time-field-display${compact ? ' is-compact' : ''}`}
        aria-label={`Edit ${label}`}
        title={compact ? `${full} (click to edit)` : 'Click to edit'}
        disabled={disabled}
        // Tabbing in opens the editor with the text selected, so typing overwrites it.
        onFocus={open}
        onClick={open}
      >
        {compact ? full.slice(0, 'YYYY-MM-DD'.length) : full}
      </button>
    );
  }

  return (
    <div
      className={`date-time-field-editor${compact ? ' is-compact' : ''}`}
      ref={wrapperRef} onBlur={onBlur}>
      <input
        type="text"
        className={`date-time-field-text${invalid ? ' is-invalid' : ''}`}
        aria-label={`${label} text`}
        aria-invalid={invalid}
        placeholder="YYYY-MM-DD HH:MM:SS"
        value={text}
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <input
        type="datetime-local"
        className="date-time-field-picker"
        aria-label={label}
        // Out of the tab order so Tab leaves the field and commits the typed text.
        tabIndex={-1}
        step={1}
        value={value}
        onChange={(e) => {
          if (!e.target.value) return;
          onChange(e.target.value);
          setText(formatDateTimeLocal(e.target.value));
        }}
      />
    </div>
  );
}
