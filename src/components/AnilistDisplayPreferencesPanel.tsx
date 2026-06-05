import { useAnilistDisplayPreferences } from '../hooks/useAnilistDisplayPreferences';

/** Display toggles for cached AniList media/staff titles — under the anilist DB row. */
export function AnilistDisplayPreferencesPanel() {
  const { prefs, setMediaTitleMode, setPersonNameMode } = useAnilistDisplayPreferences();

  return (
    <div className="settings-anilist-display-prefs">
      <div className="settings-status settings-anilist-display-prefs-title">Display names</div>
      <fieldset className="settings-anilist-display-fieldset">
        <legend className="settings-anilist-display-legend">Show titles</legend>
        <label className="settings-item checkbox">
          <input
            type="radio"
            name="anilist-media-title-mode"
            checked={prefs.mediaTitleMode === 'romaji'}
            onChange={() => setMediaTitleMode('romaji')}
          />
          Romaji
        </label>
        <label className="settings-item checkbox">
          <input
            type="radio"
            name="anilist-media-title-mode"
            checked={prefs.mediaTitleMode === 'english'}
            onChange={() => setMediaTitleMode('english')}
          />
          English
        </label>
        <label className="settings-item checkbox">
          <input
            type="radio"
            name="anilist-media-title-mode"
            checked={prefs.mediaTitleMode === 'native'}
            onChange={() => setMediaTitleMode('native')}
          />
          Native
        </label>
      </fieldset>
      <fieldset className="settings-anilist-display-fieldset">
        <legend className="settings-anilist-display-legend">People names</legend>
        <label className="settings-item checkbox">
          <input
            type="radio"
            name="anilist-person-name-mode"
            checked={prefs.personNameMode === 'full'}
            onChange={() => setPersonNameMode('full')}
          />
          Full
        </label>
        <label className="settings-item checkbox">
          <input
            type="radio"
            name="anilist-person-name-mode"
            checked={prefs.personNameMode === 'native'}
            onChange={() => setPersonNameMode('native')}
          />
          Native
        </label>
      </fieldset>
      <p className="settings-popover-hint settings-anilist-display-hint">
        Search still matches every stored title and name variant.
      </p>
    </div>
  );
}
