import { useCallback, useState } from 'react';
import type { ToolsMediaRelationsResponse } from '../lib/importers/anilist/toolsMediaRelationsApi';
import { AnilistDetailModal } from './AnilistDetailModal';
import { StaffDetailModal } from './StaffDetailModal';

export interface MediaDetailTarget {
  kind: 'media';
  mediaId: number;
  fallbackTitle: string;
  forceRefresh?: boolean;
}

export interface StaffDetailTarget {
  kind: 'staff';
  staffId: number;
  fallbackName: string;
}

export type AnilistDetailTarget = MediaDetailTarget | StaffDetailTarget;

export type OpenMediaDetail = (
  mediaId: number,
  fallbackTitle: string,
  options?: { forceRefresh?: boolean },
) => void;

export type OpenStaffDetail = (
  staffId: number,
  fallbackName: string,
) => void;

export interface AnilistDetailModalStackController {
  stack: AnilistDetailTarget[];
  openMedia: OpenMediaDetail;
  openStaff: OpenStaffDetail;
  closeTarget: (target: AnilistDetailTarget) => void;
}

/**
 * Keep at most one media and one staff modal. Opening a type already in the
 * stack replaces that older layer and makes the new target topmost.
 */
export function pushAnilistDetailTarget(
  stack: readonly AnilistDetailTarget[],
  target: AnilistDetailTarget,
): AnilistDetailTarget[] {
  return [...stack.filter((entry) => entry.kind !== target.kind), target].slice(
    -2,
  );
}

export function useAnilistDetailModalStack(): AnilistDetailModalStackController {
  const [stack, setStack] = useState<AnilistDetailTarget[]>([]);

  const openMedia = useCallback<OpenMediaDetail>(
    (mediaId, fallbackTitle, options) => {
      setStack((current) =>
        pushAnilistDetailTarget(current, {
          kind: 'media',
          mediaId,
          fallbackTitle,
          forceRefresh: options?.forceRefresh,
        }),
      );
    },
    [],
  );

  const openStaff = useCallback<OpenStaffDetail>((staffId, fallbackName) => {
    setStack((current) =>
      pushAnilistDetailTarget(current, {
        kind: 'staff',
        staffId,
        fallbackName,
      }),
    );
  }, []);

  const closeTarget = useCallback((target: AnilistDetailTarget) => {
    setStack((current) => current.filter((entry) => entry !== target));
  }, []);

  return { stack, openMedia, openStaff, closeTarget };
}

interface AnilistDetailModalStackProps
  extends AnilistDetailModalStackController {
  onMediaRelationsRefreshed?: (
    mediaId: number,
    response: ToolsMediaRelationsResponse,
  ) => void;
}

export function AnilistDetailModalStack({
  stack,
  openMedia,
  openStaff,
  closeTarget,
  onMediaRelationsRefreshed,
}: AnilistDetailModalStackProps) {
  return (
    <>
      {stack.map((target, index) => {
        const isTopmost = index === stack.length - 1;
        if (target.kind === 'media') {
          return (
            <AnilistDetailModal
              key={`media-${target.mediaId}`}
              mediaId={target.mediaId}
              fallbackTitle={target.fallbackTitle}
              initialForceRefresh={target.forceRefresh}
              onClose={() => closeTarget(target)}
              onOpenStaff={openStaff}
              onMediaRelationsRefreshed={onMediaRelationsRefreshed}
              stackIndex={index}
              isTopmost={isTopmost}
            />
          );
        }
        return (
          <StaffDetailModal
            key={`staff-${target.staffId}`}
            staffId={target.staffId}
            fallbackName={target.fallbackName}
            onClose={() => closeTarget(target)}
            onOpenMedia={openMedia}
            stackIndex={index}
            isTopmost={isTopmost}
          />
        );
      })}
    </>
  );
}
