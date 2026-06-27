import type { ChangeEvent } from 'react';

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
          <svg
            className="tool-clearable-input-icon"
            viewBox="0 0 12 12"
            aria-hidden="true"
          >
            <path
              d="M2.5 2.5 9.5 9.5 M9.5 2.5 2.5 9.5"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </span>
  );
}
