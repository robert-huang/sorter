import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { formatDateTimeLocal, parseDateTimeText } from '../lib/dateTimeText';

interface Props {
  /** `datetime-local` value, e.g. `2026-01-05T14:30`. */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Date for january". */
  label: string;
  disabled?: boolean;
}

/**
 * Date/time shown as text; clicking edits it as text with a native picker underneath.
 * Typed text is only saved when it parses; a date alone means midnight.
 */
export function DateTimeField({ value, onChange, label, disabled = false }: Props) {
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
    return (
      <button
        type="button"
        className="date-time-field-display"
        aria-label={`Edit ${label}`}
        title="Click to edit"
        disabled={disabled}
        onClick={open}
      >
        {formatDateTimeLocal(value)}
      </button>
    );
  }

  return (
    <div className="date-time-field-editor" ref={wrapperRef} onBlur={onBlur}>
      <input
        type="text"
        className={`date-time-field-text${invalid ? ' is-invalid' : ''}`}
        aria-label={`${label} text`}
        aria-invalid={invalid}
        placeholder="YYYY-MM-DD HH:MM"
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <input
        type="datetime-local"
        className="date-time-field-picker"
        aria-label={label}
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
