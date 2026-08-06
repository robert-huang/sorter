import type { ChangeEvent } from 'react';
import { RemoveGlyph } from '../components/RemoveGlyph';

interface Props {
  id: string;
  className?: string;
  type?: 'text' | 'number';
  value: string;
  disabled?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: string) => void;
}

/** Compact tool input with hover × to clear (replaces number spinners). */
export function ToolClearableInput({
  id,
  className,
  type = 'text',
  value,
  disabled,
  placeholder,
  min,
  max,
  step,
  onChange,
}: Props) {
  const hasValue = value.length > 0;

  return (
    <span className="tool-clearable-input">
      <input
        id={id}
        className={['slot-search', className].filter(Boolean).join(' ')}
        type={type}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
      {hasValue && (
        <button
          type="button"
          className="tool-clearable-input-clear"
          disabled={disabled}
          tabIndex={-1}
          aria-label="Clear field"
          title="Clear"
          onClick={() => onChange('')}
        >
          <RemoveGlyph size={12} className="tool-clearable-input-icon" />
        </button>
      )}
    </span>
  );
}
