import { useCallback, useState } from 'react';
import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { currentPageUrl } from '../lib/appRoutes';
import type { CachedOptimalPathResult } from './cachedGraph';
import { formatPathSummary, type PathStep } from './pathHistory';
import { WinPathTrail } from './WinPathTrail';

export type RoundEndOutcome = 'won' | 'gave_up';

interface Props {
  outcome: RoundEndOutcome;
  startMedia: MediaRow;
  goalMedia: MediaRow;
  linksUsed: number;
  pathHistory: readonly PathStep[];
  onPlayAgain: () => void;
  onFindCachedPath?: () => Promise<CachedOptimalPathResult>;
  /** Open the detail modal for a path node (result-screen only). */
  onOpenStep?: (step: PathStep) => void;
  /** Open the media detail modal for the start/goal tiles. */
  onOpenMedia?: (mediaId: number, fallbackTitle: string) => void;
}

/**
 * Start/goal title in the result header. Renders as a button that opens
 * the media detail modal when an opener is wired, otherwise as plain
 * bold text (keeps the in-game / no-opener rendering unchanged).
 */
function RouteTitle({
  media,
  onOpenMedia,
}: {
  media: MediaRow;
  onOpenMedia?: (mediaId: number, fallbackTitle: string) => void;
}) {
  const title = pickMediaTitle(media);
  if (!onOpenMedia) {
    return <strong>{title}</strong>;
  }
  return (
    <button
      type="button"
      className="anime-to-anime-win-route-link"
      onClick={() => onOpenMedia(media.id, title)}
    >
      {title}
    </button>
  );
}

type CachedPathUiState =
  | { phase: 'idle' }
  | { phase: 'searching' }
  | { phase: 'found'; linksUsed: number; steps: PathStep[] }
  | { phase: 'not_found' };

function buildSummaryCopyText(
  outcome: RoundEndOutcome,
  startMedia: MediaRow,
  goalMedia: MediaRow,
  linksUsed: number,
  pathHistory: readonly PathStep[],
  pageUrl: string,
): string {
  const start = pickMediaTitle(startMedia);
  const goal = pickMediaTitle(goalMedia);
  const pathLine =
    pathHistory.length > 1 ? `\n${formatPathSummary(pathHistory)}` : '';
  const urlLine = pageUrl ? `\n${pageUrl}` : '';
  const headline =
    outcome === 'won'
      ? `Anime to Anime: ${start} → ${goal} in ${linksUsed} link${linksUsed === 1 ? '' : 's'} used`
      : `Anime to Anime (gave up): ${start} → ${goal} after ${linksUsed} link${linksUsed === 1 ? '' : 's'}`;
  return `${headline}${pathLine}${urlLine}`;
}

function cachedPathNotFoundMessage(outcome: RoundEndOutcome): string {
  if (outcome === 'gave_up') {
    return 'No path found in your local cache — expand more shows/staff or try different round rules.';
  }
  return 'Could not look up a shorter path in your cache — yours may already be optimal among known edges.';
}

export function WinScreen({
  outcome,
  startMedia,
  goalMedia,
  linksUsed,
  pathHistory,
  onPlayAgain,
  onFindCachedPath,
  onOpenStep,
  onOpenMedia,
}: Props) {
  const [cachedPath, setCachedPath] = useState<CachedPathUiState>({ phase: 'idle' });
  const [summaryCopied, setSummaryCopied] = useState(false);

  const onCopySummary = async () => {
    const summaryText = buildSummaryCopyText(
      outcome,
      startMedia,
      goalMedia,
      linksUsed,
      pathHistory,
      currentPageUrl(),
    );
    try {
      await navigator.clipboard.writeText(summaryText);
      setSummaryCopied(true);
      setTimeout(() => setSummaryCopied(false), 1500);
    } catch {
      setSummaryCopied(false);
    }
  };

  const onSearchCachedPath = useCallback(() => {
    if (!onFindCachedPath || cachedPath.phase === 'searching') {
      return;
    }
    setCachedPath({ phase: 'searching' });
    void onFindCachedPath()
      .then((result) => {
        if (result.status === 'found') {
          setCachedPath({
            phase: 'found',
            linksUsed: result.linksUsed,
            steps: result.steps,
          });
          return;
        }
        setCachedPath({ phase: 'not_found' });
      })
      .catch(() => {
        setCachedPath({ phase: 'not_found' });
      });
  }, [cachedPath.phase, onFindCachedPath]);

  const cachedSearchDisabled = !onFindCachedPath || cachedPath.phase === 'searching';
  const showCachedButton =
    onFindCachedPath &&
    cachedPath.phase !== 'found' &&
    cachedPath.phase !== 'not_found';

  const title = outcome === 'won' ? 'Goal reached!' : 'Round ended';
  const linksLabel = outcome === 'won' ? 'Links used' : 'Links used before giving up';

  return (
    <section className="page-section anime-to-anime-win">
      <h2 className="anime-to-anime-win-title">{title}</h2>
      <p className="anime-to-anime-win-route">
        <RouteTitle media={startMedia} onOpenMedia={onOpenMedia} />
        <span aria-hidden="true"> → </span>
        <RouteTitle media={goalMedia} onOpenMedia={onOpenMedia} />
      </p>
      <p className="anime-to-anime-win-hops">
        {linksLabel}: <strong>{linksUsed}</strong>
      </p>
      {pathHistory.length > 1 && (
        <WinPathTrail steps={pathHistory} onOpenStep={onOpenStep} />
      )}
      <div className="anime-to-anime-actions anime-to-anime-win-actions">
        {showCachedButton && (
          <button
            type="button"
            className="btn"
            disabled={cachedSearchDisabled}
            onClick={onSearchCachedPath}
          >
            {cachedPath.phase === 'searching' ? 'Searching…' : 'Shortest path (cached)'}
          </button>
        )}
        <button type="button" className="btn primary" onClick={() => void onCopySummary()}>
          {summaryCopied ? '✓ Copied' : outcome === 'won' ? 'Share Results' : 'Copy summary'}
        </button>
        <button type="button" className="btn" onClick={onPlayAgain}>
          Play Again
        </button>
      </div>
      {cachedPath.phase === 'found' && (
        <div className="anime-to-anime-win-cached">
          <p className="anime-to-anime-win-cached-summary">
            {outcome === 'won' ? (
              <>
                Shortest in cache: <strong>{cachedPath.linksUsed}</strong> link
                {cachedPath.linksUsed === 1 ? '' : 's'}
                {' · '}
                Your path: <strong>{linksUsed}</strong> link{linksUsed === 1 ? '' : 's'}
              </>
            ) : (
              <>
                Shortest in cache: <strong>{cachedPath.linksUsed}</strong> link
                {cachedPath.linksUsed === 1 ? '' : 's'}
                {linksUsed > 0 && (
                  <>
                    {' · '}
                    You had used: <strong>{linksUsed}</strong> link
                    {linksUsed === 1 ? '' : 's'}
                  </>
                )}
              </>
            )}
          </p>
          {cachedPath.steps.length > 1 && (
            <WinPathTrail steps={cachedPath.steps} onOpenStep={onOpenStep} />
          )}
        </div>
      )}
      {cachedPath.phase === 'not_found' && (
        <p className="anime-to-anime-win-cached-hint">
          {cachedPathNotFoundMessage(outcome)}
        </p>
      )}
    </section>
  );
}
