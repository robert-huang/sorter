import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { formatPathSummary, type PathStep } from './pathHistory';

interface Props {
  startMedia: MediaRow;
  goalMedia: MediaRow;
  animeHops: number;
  pathHistory: readonly PathStep[];
  onPlayAgain: () => void;
  onSetup: () => void;
}

function buildShareText(
  startMedia: MediaRow,
  goalMedia: MediaRow,
  animeHops: number,
  pathHistory: readonly PathStep[],
): string {
  const start = pickMediaTitle(startMedia);
  const goal = pickMediaTitle(goalMedia);
  const pathLine =
    pathHistory.length > 1 ? `\n${formatPathSummary(pathHistory)}` : '';
  return `Anime to Anime: ${start} → ${goal} in ${animeHops} anime hop${animeHops === 1 ? '' : 's'}${pathLine}`;
}

export function WinScreen({
  startMedia,
  goalMedia,
  animeHops,
  pathHistory,
  onPlayAgain,
  onSetup,
}: Props) {
  const shareText = buildShareText(startMedia, goalMedia, animeHops, pathHistory);

  const onShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ text: shareText });
        return;
      } catch {
        /* user cancelled or share failed — fall through to copy */
      }
    }
    await navigator.clipboard.writeText(shareText);
  };

  return (
    <section className="page-section anime-to-anime-win">
      <h2 className="anime-to-anime-win-title">Goal reached!</h2>
      <p className="anime-to-anime-win-route">
        <strong>{pickMediaTitle(startMedia)}</strong>
        <span aria-hidden="true"> → </span>
        <strong>{pickMediaTitle(goalMedia)}</strong>
      </p>
      <p className="anime-to-anime-win-hops">
        Anime hops: <strong>{animeHops}</strong>
      </p>
      {pathHistory.length > 1 && (
        <p className="anime-to-anime-win-path">{formatPathSummary(pathHistory)}</p>
      )}
      <div className="anime-to-anime-actions anime-to-anime-win-actions">
        <button type="button" className="btn primary" onClick={() => void onShare()}>
          {typeof navigator.share === 'function' ? 'Share summary' : 'Copy summary'}
        </button>
        <button type="button" className="btn" onClick={onPlayAgain}>
          Play again
        </button>
        <button type="button" className="btn small" onClick={onSetup}>
          Setup
        </button>
      </div>
    </section>
  );
}
