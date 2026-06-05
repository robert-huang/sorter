import { GITHUB_REPO_URL } from '../lib/appRoutes';
import { GitHubIcon } from './icons';

/**
 * Icon-only footer link to the project repo — shared by Sorter and
 * Anime to Anime gear menus. Rendered inline on the autosave status row
 * (right-aligned), so it returns just the anchor with no own wrapper.
 */
export function SettingsGitHubLink() {
  return (
    <a
      href={GITHUB_REPO_URL}
      className="settings-github-link"
      target="_blank"
      rel="noopener noreferrer"
      title="View source on GitHub"
      aria-label="View source on GitHub"
    >
      <GitHubIcon size={14} />
    </a>
  );
}
