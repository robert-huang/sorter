type ToolUsernameFieldProps = {
  label: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  /** Non-standard name so browsers do not treat this as login/payment autofill. */
  inputName?: string;
  /** Optional hint shown inline to the right of the input (and refresh button). */
  hint?: string | null;
  /** When set, shows a refresh button to the right of the input (a2a style). */
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshLabel?: string;
};

const DEFAULT_REFRESH_LABEL = 'Refresh list from AniList';

/** AniList username field matching anime-to-anime width and layout. */
export function ToolUsernameField({
  label,
  value,
  disabled,
  placeholder = 'AL Username',
  onChange,
  inputName = 'anilist-username',
  hint,
  onRefresh,
  refreshing,
  refreshLabel = DEFAULT_REFRESH_LABEL,
}: ToolUsernameFieldProps) {
  return (
    <label className="tool-field tool-field-label-row tool-field-username">
      <span className="tool-field-label">{label}</span>
      <div className="anime-to-anime-endpoint-user">
        <input
          className="slot-search anime-to-anime-endpoint-user-input"
          type="text"
          name={inputName}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
        {onRefresh && (
          <button
            type="button"
            className="btn icon-only anime-to-anime-refresh-btn anime-to-anime-refresh-btn--compact anime-to-anime-random-btn"
            disabled={disabled || refreshing || value.trim().length === 0}
            onClick={onRefresh}
            title={refreshLabel}
            aria-label={refreshLabel}
          >
            ↻
          </button>
        )}
      </div>
      {hint && <span className="tool-field-hint tool-field-hint-inline">{hint}</span>}
    </label>
  );
}
