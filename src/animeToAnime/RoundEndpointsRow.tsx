import type { AnilistImportContext } from '../lib/importers/anilist/context';
import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';
import { EndpointPicker } from './EndpointPicker';

interface Props {
  phase: 'setup' | 'play' | 'won';
  startMedia: MediaRow | null;
  goalMedia: MediaRow | null;
  animeHops?: number;
  swapDisabled: boolean;
  importCtx?: AnilistImportContext;
  onSelectStart?: (media: MediaRow) => void;
  onSelectGoal?: (media: MediaRow) => void;
  onEndpointError?: (message: string | null) => void;
  onRandomStart: () => void;
  onRandomGoal: () => void;
  onSwap: () => void;
}

function PlayEndpointCard({ label, media }: { label: string; media: MediaRow | null }) {
  return (
    <section className="page-section anime-to-anime-endpoint-card">
      <h2 className="anime-to-anime-section-title">{label}</h2>
      {media?.cover_image && (
        <img src={media.cover_image} alt="" className="anime-to-anime-endpoint-cover" />
      )}
      <p className="anime-to-anime-endpoint-value">{media ? pickMediaTitle(media) : '—'}</p>
    </section>
  );
}

export function RoundEndpointsRow({
  phase,
  startMedia,
  goalMedia,
  animeHops,
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
            <div className="anime-to-anime-endpoints-bridge">
              <span className="anime-to-anime-endpoints-arrow" aria-hidden="true">
                →
              </span>
              <button
                type="button"
                className="btn small"
                onClick={onSwap}
                disabled={swapDisabled}
                title="Swap start and goal"
              >
                Swap
              </button>
            </div>
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
            <div className="anime-to-anime-endpoints-bridge">
              <span className="anime-to-anime-endpoints-arrow" aria-hidden="true">
                →
              </span>
              {phase === 'play' && (
                <button
                  type="button"
                  className="btn small"
                  onClick={onSwap}
                  disabled={swapDisabled}
                  title="Swap start and goal"
                >
                  Swap
                </button>
              )}
            </div>
            <PlayEndpointCard label="Goal" media={goalMedia} />
          </>
        )}
      </div>
      {showHops && (
        <p className="anime-to-anime-hops">Anime hops: {animeHops ?? 0}</p>
      )}
    </div>
  );
}
