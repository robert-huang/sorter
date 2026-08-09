import type { ReactNode } from 'react';
import { CircularArrowGlyph } from '../components/CircularArrowGlyph';

type ToolUsernameFieldProps = {
  /** Visible label; omit for compact inline fields with an aria-label. */
  label?: string;
  inputAriaLabel?: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  /** Non-login field name kept distinct across multi-username forms. */
  inputName?: string;
  /** Optional hint shown inline to the right of the input (and refresh button). */
  hint?: string | null;
  /** When set, shows a refresh button to the right of the input. */
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshLabel?: string;
  /** Optional compact control placed immediately after the refresh button. */
  trailingControl?: ReactNode;
};

const DEFAULT_REFRESH_LABEL = 'Refresh list from AniList';

/** Shared AniList username field used by tool panels. */
export function ToolUsernameField({
  label,
  inputAriaLabel,
  value,
  disabled,
  placeholder = 'AL Username',
  onChange,
  inputName = 'anilist-username',
  hint,
  onRefresh,
  refreshing,
  refreshLabel = DEFAULT_REFRESH_LABEL,
  trailingControl,
}: ToolUsernameFieldProps) {
  return (
    <label className="tool-field tool-field-label-row tool-field-username">
      {label && <span className="tool-field-label">{label}</span>}
      <div className="tool-username-input-group">
        <input
          className="slot-search tool-username-input"
          type="text"
          name={inputName}
          aria-label={inputAriaLabel}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="one-time-code"
          data-1p-ignore
          data-lpignore="true"
        />
        {onRefresh && (
          <button
            type="button"
            className="btn icon-only tool-username-refresh"
            disabled={disabled || refreshing || value.trim().length === 0}
            onClick={onRefresh}
            title={refreshLabel}
            aria-label={refreshLabel}
          >
            <CircularArrowGlyph />
          </button>
        )}
        {trailingControl}
      </div>
      {hint && <span className="tool-field-hint tool-field-hint-inline">{hint}</span>}
    </label>
  );
}
