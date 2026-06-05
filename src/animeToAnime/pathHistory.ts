import type { MediaTitleFields } from '../lib/importers/anilist/mediaDisplayLabel';
import type { PersonNameFields } from '../lib/importers/anilist/personDisplayLabel';

export type PathStep =
  | {
      kind: 'anime';
      mediaId: number;
      title: string;
      coverImage: string | null;
      /**
       * Raw title fields, kept so the node can be relabelled in place
       * when the media-title display preference changes mid-round.
       */
      titleFields?: MediaTitleFields;
      /** Role / relation label for the hop that arrived at this step (edge tooltip). */
      viaLabel?: string;
    }
  | {
      kind: 'staff';
      staffId: number;
      name: string;
      image: string | null;
      /** Raw name fields, kept so the node can be relabelled in place. */
      nameFields?: PersonNameFields;
      viaLabel?: string;
    };

export function pathStepLabel(step: PathStep): string {
  return step.kind === 'anime' ? step.title : step.name;
}

export function formatPathSummary(steps: readonly PathStep[]): string {
  return steps.map(pathStepLabel).join(' → ');
}
