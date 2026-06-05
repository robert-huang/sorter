import type { PathStep } from './pathHistory';

interface Props {
  steps: readonly PathStep[];
}

function StepCircle({ step, isCurrent }: { step: PathStep; isCurrent: boolean }) {
  const imageSrc = step.kind === 'anime' ? step.coverImage : step.image;
  const label = step.kind === 'anime' ? step.title : step.name;
  const initial = label.trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      className={`anime-to-anime-path-step${isCurrent ? ' anime-to-anime-path-step--current' : ''}`}
      title={label}
    >
      {imageSrc ? (
        <img src={imageSrc} alt="" className="anime-to-anime-path-step-img" />
      ) : (
        <span className="anime-to-anime-path-step-initial" aria-hidden="true">
          {initial}
        </span>
      )}
    </div>
  );
}

function EdgeConnector({ kind }: { kind: 'anime' | 'staff' }) {
  return (
    <span
      className={`anime-to-anime-path-edge anime-to-anime-path-edge--${kind}`}
      aria-hidden="true"
    >
      →
    </span>
  );
}

export function PathHistoryTrail({ steps }: Props) {
  if (steps.length === 0) {
    return null;
  }

  return (
    <div className="anime-to-anime-path-trail" aria-label="Path history">
      {steps.map((step, index) => (
        <span
          key={`${step.kind}-${step.kind === 'anime' ? step.mediaId : step.staffId}-${index}`}
          className="anime-to-anime-path-segment"
        >
          {index > 0 && (
            <EdgeConnector kind={step.kind === 'anime' ? 'anime' : 'staff'} />
          )}
          <StepCircle step={step} isCurrent={index === steps.length - 1} />
        </span>
      ))}
    </div>
  );
}
