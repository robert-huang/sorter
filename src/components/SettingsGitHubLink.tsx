import { GITHUB_REPO_URL } from '../lib/appRoutes';
import { GitHubIcon } from './icons';

/** Footer link to the project repo — shared by Sorter and Anime to Anime gear menus. */
export function SettingsGitHubLink() {
  return (
    <div className="settings-status">
      <a
        href={GITHUB_REPO_URL}
        className="settings-github-link"
        target="_blank"
        rel="noopener noreferrer"
        title="View source on GitHub"
      >
        <GitHubIcon size={12} />
        <span>GitHub</span>
      </a>
    </div>
  );
}
