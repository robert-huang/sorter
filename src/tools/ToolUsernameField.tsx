import { RefreshIcon } from '../components/icons';

type ToolUsernameFieldProps = {
  label: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  /** When set, shows a refresh icon button to the right of the input. */
  onRefresh?: () => void;
  refreshing?: boolean;
};

/** AniList username field matching anime-to-anime width and layout. */
export function ToolUsernameField({
  label,
  value,
  disabled,
  placeholder = 'AL Username',
  onChange,
  onRefresh,
  refreshing,
}: ToolUsernameFieldProps) {
  return (
    <label className="tool-field tool-field-label-row tool-field-username">
      <span className="tool-field-label">{label}</span>
      <div className="anime-to-anime-endpoint-user">
        <input
          className="slot-search anime-to-anime-endpoint-user-input"
          type="text"
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {onRefresh && (
          <button
            type="button"
            className="btn small icon-only anime-to-anime-random-btn"
            disabled={disabled || refreshing || value.trim().length === 0}
            onClick={onRefresh}
            aria-label="Refresh list from AniList"
          >
            <RefreshIcon size={16} />
          </button>
        )}
      </div>
    </label>
  );
}
