import {
  buildAnilistFavouriteUrl,
  buildAnilistMediaUrl,
} from '../lib/importers/anilist/anilistSource';
import type { MediaRow, StaffRow } from '../lib/importers/anilist/types';
import type { PathStep } from './pathHistory';

// The generic middle-click binder and AniList URL helpers live in the lib
// layer so shared components (e.g. AnilistDetailModal) can use them without
// importing from the animeToAnime feature. Re-exported here for the many
// existing call sites in this feature.
export {
  anilistUrlForCharacter,
  anilistUrlForStaffId,
  anilistUrlForMediaEntry,
  bindAnilistMiddleClick,
  mergeAnilistLinkClass,
} from '../lib/importers/anilist/anilistLinks';

export function anilistUrlForMedia(media: Pick<MediaRow, 'id' | 'type'>): string {
  return buildAnilistMediaUrl(media.type, media.id);
}

export function anilistUrlForStaff(staff: Pick<StaffRow, 'id'>): string {
  return buildAnilistFavouriteUrl('STAFF', staff.id);
}

export function anilistUrlForPathStep(step: PathStep): string {
  if (step.kind === 'anime') {
    return buildAnilistMediaUrl('ANIME', step.mediaId);
  }
  return buildAnilistFavouriteUrl('STAFF', step.staffId);
}
