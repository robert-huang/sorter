import type { ChangeEvent } from 'react';
import { RemoveGlyph } from '../components/RemoveGlyph';

interface Props {
  id: string;
  className?: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  onChange: (value: string) => void;
}

/** Multiline tool field with hover × to clear (notes, free text). */
export function ToolClearableTextarea({
  id,
  className,
  value,
  disabled,
  placeholder,
  rows = 1,
  onChange,
}: Props) {
  const hasValue = value.length > 0;

  return (
    <span className="tool-clearable-input tool-clearable-input--multiline">
      <textarea
        id={id}
        className={['slot-search', className].filter(Boolean).join(' ')}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
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
