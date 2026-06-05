import type { AnilistImportContext } from '../lib/importers/anilist/context';
import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import {
  anilistUrlForMedia,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from './anilistMiddleClick';
import { EndpointPicker } from './EndpointPicker';
import { EndpointsSwapArrow } from './endpointsSwapArrow';

interface Props {
  phase: 'setup' | 'play' | 'won';
  startMedia: MediaRow | null;
  goalMedia: MediaRow | null;
  linksUsed?: number;
  swapDisabled: boolean;
  importCtx?: AnilistImportContext;
  onSelectStart?: (media: MediaRow) => void;
  onSelectGoal?: (media: MediaRow) => void;
  onEndpointError?: (message: string | null) => void;
  onRandomStart: () => void;
  onRandomGoal: () => void;
  onSwap: () => void;
}

function EndpointsSwapBridge({
  swapDisabled,
  onSwap,
  interactive,
}: {
  swapDisabled: boolean;
  onSwap: () => void;
  interactive: boolean;
}) {
  const arrow = (
    <span className="anime-to-anime-swap-arrow-wrap">
      <EndpointsSwapArrow />
    </span>
  );

  if (!interactive) {
    return <div className="anime-to-anime-endpoints-bridge">{arrow}</div>;
  }

  return (
    <div className="anime-to-anime-endpoints-bridge">
      <button
        type="button"
        className="anime-to-anime-swap-btn"
        onClick={onSwap}
        disabled={swapDisabled}
        title="Swap start and goal"
        aria-label="Swap start and goal"
      >
        {arrow}
      </button>
    </div>
  );
}

function PlayEndpointCard({ label, media }: { label: string; media: MediaRow | null }) {
  const anilistLink = bindAnilistMiddleClick(media ? anilistUrlForMedia(media) : null);

  return (
    <section className="page-section anime-to-anime-endpoint-card">
      <h2 className="anime-to-anime-section-title">{label}</h2>
      <div
        className={mergeAnilistLinkClass(
          'anime-to-anime-endpoint-play-preview',
          anilistLink.className,
        )}
        title={anilistLink.title}
        onMouseDown={anilistLink.onMouseDown}
        onAuxClick={anilistLink.onAuxClick}
      >
        {media?.cover_image && (
          <img src={media.cover_image} alt="" className="anime-to-anime-endpoint-cover" />
        )}
        <p className="anime-to-anime-endpoint-value">{media ? pickMediaTitle(media) : '—'}</p>
      </div>
    </section>
  );
}

export function RoundEndpointsRow({
  phase,
  startMedia,
  goalMedia,
  linksUsed,
  swapDisabled,
  importCtx,
  onSelectStart,
  onSelectGoal,
  onEndpointError,
  onRandomStart,
  onRandomGoal,
  onSwap,
}: Props) {
  const showHops = phase === 'play';

  return (
    <div className="anime-to-anime-endpoints-wrap">
      <div className="anime-to-anime-endpoints">
        {phase === 'setup' && importCtx && onSelectStart && onSelectGoal && onEndpointError ? (
          <>
            <EndpointPicker
              label="Start"
              media={startMedia}
              importCtx={importCtx}
              onSelect={onSelectStart}
              onRandomFromCache={onRandomStart}
              onError={onEndpointError}
            />
            <EndpointsSwapBridge
              swapDisabled={swapDisabled}
              onSwap={onSwap}
              interactive
            />
            <EndpointPicker
              label="Goal"
              media={goalMedia}
              importCtx={importCtx}
              onSelect={onSelectGoal}
              onRandomFromCache={onRandomGoal}
              onError={onEndpointError}
            />
          </>
        ) : (
          <>
            <PlayEndpointCard label="Start" media={startMedia} />
            <EndpointsSwapBridge
              swapDisabled={swapDisabled}
              onSwap={onSwap}
              interactive={phase === 'play'}
            />
            <PlayEndpointCard label="Goal" media={goalMedia} />
          </>
        )}
      </div>
      {showHops && (
        <p className="anime-to-anime-hops">Links used: {linksUsed ?? 0}</p>
      )}
    </div>
  );
}
