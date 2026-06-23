import { useAnilistDisplayPreferences } from '../hooks/useAnilistDisplayPreferences';
import type {
  MediaTitleDisplayMode,
  PersonNameDisplayMode,
} from '../lib/importers/anilist/displayPreferences';

// Romaji is the default, so it leads the segmented control.
const TITLE_OPTIONS: { value: MediaTitleDisplayMode; label: string }[] = [
  { value: 'romaji', label: 'Romaji' },
  { value: 'english', label: 'English' },
  { value: 'native', label: 'Native' },
];

const NAME_OPTIONS: { value: PersonNameDisplayMode; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'native', label: 'Native' },
];

/** Display toggles for cached AniList media/staff titles — under the anilist DB row. */
export function AnilistDisplayPreferencesPanel({
  standalone = false,
}: {
  /** When true, drop the source-db nested indent (Tools settings tab). */
  standalone?: boolean;
}) {
  const { prefs, setMediaTitleMode, setPersonNameMode } = useAnilistDisplayPreferences();

  return (
    <>
      {/* Title sits OUTSIDE the indented block so it aligns with the
          rest of the source-db row, not double-indented with the
          entry/staff rows. */}
      <div className="settings-status settings-anilist-display-prefs-title">Display names</div>
      <div
        className={`settings-anilist-display-prefs${standalone ? ' settings-anilist-display-prefs--standalone' : ''}`}
      >
        <div className="filter-chip-range-row">
          <span>entry</span>
          <div className="filter-chip-segmented" role="group" aria-label="entry">
            {TITLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={prefs.mediaTitleMode === option.value ? 'active' : ''}
                aria-pressed={prefs.mediaTitleMode === option.value}
                onClick={() => setMediaTitleMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="filter-chip-range-row">
          <span>staff</span>
          <div className="filter-chip-segmented" role="group" aria-label="staff">
            {NAME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={prefs.personNameMode === option.value ? 'active' : ''}
                aria-pressed={prefs.personNameMode === option.value}
                onClick={() => setPersonNameMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
