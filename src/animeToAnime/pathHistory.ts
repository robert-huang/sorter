import type { MediaTitleFields } from '../lib/importers/anilist/mediaDisplayLabel';
import type { PersonNameFields } from '../lib/importers/anilist/personDisplayLabel';

/**
 * Character(s) that a voice-actor hop passed through, captured so the path
 * arrow can middle-click open the character page(s) on AniList. A single hop
 * can cover several characters (a VA voiced multiple roles in one show).
 */
export type PathHopCharacter = {
  id: number;
  name: string;
};

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
      /** VA characters this hop passed through (only set for voice hops). */
      viaCharacters?: readonly PathHopCharacter[];
    }
  | {
      kind: 'staff';
      staffId: number;
      name: string;
      image: string | null;
      /** Raw name fields, kept so the node can be relabelled in place. */
      nameFields?: PersonNameFields;
      viaLabel?: string;
      /** VA characters this hop passed through (only set for voice hops). */
      viaCharacters?: readonly PathHopCharacter[];
    };

export function pathStepLabel(step: PathStep): string {
  return step.kind === 'anime' ? step.title : step.name;
}

export function formatPathSummary(steps: readonly PathStep[]): string {
  return steps.map(pathStepLabel).join(' → ');
}
