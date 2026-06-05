import type { PathStep } from './pathHistory';
import { PathStepBubble, PathTrailEdge } from './pathStepVisual';

interface Props {
  steps: readonly PathStep[];
}

export function PathHistoryTrail({ steps }: Props) {
  if (steps.length === 0) {
    return null;
  }

  return (
    <div className="anime-to-anime-path-trail" aria-label="Path history">
      {steps.flatMap((step, index) => {
        const stepKey =
          step.kind === 'anime'
            ? `anime-${step.mediaId}-${index}`
            : `staff-${step.staffId}-${index}`;

        const circle = (
          <PathStepBubble
            key={stepKey}
            step={step}
            isCurrent={index === steps.length - 1}
          />
        );

        if (index === 0) {
          return [circle];
        }

        return [
          <PathTrailEdge
            key={`edge-${stepKey}`}
            kind={step.kind === 'anime' ? 'anime' : 'staff'}
          />,
          circle,
        ];
      })}
    </div>
  );
}
