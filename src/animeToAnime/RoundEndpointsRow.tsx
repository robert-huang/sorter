import type { MediaRow } from '../lib/importers/anilist/types';
import { pickMediaTitle } from '../lib/importers/anilist/mediaDisplayLabel';

interface Props {
  phase: 'setup' | 'play';
  startMedia: MediaRow | null;
  goalMedia: MediaRow | null;
  animeHops?: number;
  goalReached?: boolean;
  swapDisabled: boolean;
  onRandomStart: () => void;
  onRandomGoal: () => void;
  onSwap: () => void;
}

function EndpointCard({
  label,
  media,
  phase,
  onRandom,
}: {
  label: string;
  media: MediaRow | null;
  phase: 'setup' | 'play';
  onRandom: () => void;
}) {
  return (
    <section className="page-section anime-to-anime-endpoint-card">
      <h2 className="anime-to-anime-section-title">{label}</h2>
      {media?.cover_image && (
        <img
          src={media.cover_image}
          alt=""
          className="anime-to-anime-endpoint-cover"
        />
      )}
      <p className="anime-to-anime-endpoint-value">
        {media ? pickMediaTitle(media) : '—'}
      </p>
      {phase === 'setup' && (
        <div className="anime-to-anime-actions">
          <button type="button" className="btn small" onClick={onRandom}>
            Random from cache
          </button>
        </div>
      )}
    </section>
  );
}

export function RoundEndpointsRow({
  phase,
  startMedia,
  goalMedia,
  animeHops,
  goalReached,
  swapDisabled,
  onRandomStart,
  onRandomGoal,
  onSwap,
}: Props) {
  return (
    <div className="anime-to-anime-endpoints-wrap">
      <div className="anime-to-anime-endpoints">
        <EndpointCard
          label="Start"
          media={startMedia}
          phase={phase}
          onRandom={onRandomStart}
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
        <EndpointCard
          label="Goal"
          media={goalMedia}
          phase={phase}
          onRandom={onRandomGoal}
        />
      </div>
      {phase === 'play' && (
        <p className="anime-to-anime-hops">
          Anime hops: {animeHops ?? 0}
          {goalReached && (
            <strong className="anime-to-anime-goal-reached"> Goal reached!</strong>
          )}
        </p>
      )}
    </div>
  );
}
