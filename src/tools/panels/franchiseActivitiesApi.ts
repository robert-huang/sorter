import { depaginate, type DepaginateProgress } from '../../lib/importers/anilist/depaginate';
import { AnilistUnknownUserError } from '../../lib/importers/anilist/importer';
import { RESOLVE_USER_QUERY } from '../../lib/importers/anilist/queries';
import { executeAnilistQuery } from '../../lib/importers/anilist/transport';
import type { AnilistUserResolveResponse } from '../../lib/importers/anilist/types';
import { withSessionMemo } from '../../lib/importers/anilist/toolsSessionMemo';
import { pickMediaTitle } from './sharedCreditsLogic';
import {
  enforceFranchiseActivitiesCacheBudget,
  franchiseActivitiesCacheKeys,
  readFranchiseActivitiesCache,
  writeFranchiseActivitiesCache,
} from './franchiseActivitiesCache';
import type { FranchiseActivity } from './franchiseActivitiesLogic';

export const FRANCHISE_ACTIVITIES_QUERY = `
query FranchiseActivities(
  $userId: Int!
  $mediaIds: [Int!]
  $page: Int!
  $perPage: Int!
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage currentPage }
    activities(
      userId: $userId
      mediaId_in: $mediaIds
      type: MEDIA_LIST
      sort: ID_DESC
    ) {
      __typename
      ... on ListActivity {
        id
        status
        progress
        createdAt
        siteUrl
        replyCount
        media {
          id
          type
          siteUrl
          title { english romaji native }
        }
      }
    }
  }
}
`;

type ApiListActivity = {
  __typename?: string;
  id?: number;
  status?: string;
  progress?: string | null;
  createdAt?: number;
  siteUrl?: string | null;
  replyCount?: number | null;
  media?: {
    id?: number;
    type?: string | null;
    siteUrl?: string | null;
    title?: {
      english?: string | null;
      romaji?: string | null;
      native?: string | null;
    } | null;
  } | null;
};

type ActivitiesPageResponse = {
  Page?: {
    pageInfo?: { hasNextPage?: boolean; currentPage?: number | null } | null;
    activities?: ApiListActivity[] | null;
  } | null;
};

export type FranchiseActivitiesProgress =
  | { phase: 'cache'; cachedMedia: number; totalMedia: number }
  | { phase: 'fetch'; page: number; collected: number };

export type FetchFranchiseActivitiesOptions = {
  username: string;
  mediaIds: readonly number[];
  signal?: AbortSignal;
  forceRefresh?: boolean;
  onProgress?: (progress: FranchiseActivitiesProgress) => void;
};

async function resolveActivityUser(
  username: string,
  signal?: AbortSignal,
): Promise<{ id: number; name: string }> {
  signal?.throwIfAborted();
  const normalizedUsername = username.trim().toLocaleLowerCase();
  const user = await withSessionMemo(
    `tools:franchise-activities:user:${normalizedUsername}`,
    async () => {
      const data = await executeAnilistQuery<AnilistUserResolveResponse>(
        RESOLVE_USER_QUERY,
        { username: username.trim() },
      );
      return data?.User ?? null;
    },
  );
  signal?.throwIfAborted();
  if (!user) {
    throw new AnilistUnknownUserError(username.trim());
  }
  return user;
}

function parseActivity(node: ApiListActivity): FranchiseActivity | null {
  if (
    node.__typename !== 'ListActivity' ||
    typeof node.id !== 'number' ||
    typeof node.status !== 'string' ||
    typeof node.createdAt !== 'number' ||
    !node.media ||
    typeof node.media.id !== 'number'
  ) {
    return null;
  }
  const mediaType = node.media.type === 'MANGA' ? 'MANGA' : 'ANIME';
  const mediaUrl =
    node.media.siteUrl ??
    `https://anilist.co/${mediaType.toLocaleLowerCase()}/${node.media.id}`;
  return {
    id: node.id,
    status: node.status,
    progress: typeof node.progress === 'string' ? node.progress : null,
    createdAt: node.createdAt,
    siteUrl: node.siteUrl ?? `https://anilist.co/activity/${node.id}`,
    replyCount:
      typeof node.replyCount === 'number' && node.replyCount > 0
        ? node.replyCount
        : 0,
    media: {
      id: node.media.id,
      type: mediaType,
      title: pickMediaTitle(node.media.title ?? {}),
      siteUrl: mediaUrl,
    },
  };
}

async function fetchMissingActivities(
  userId: number,
  mediaIds: readonly number[],
  signal: AbortSignal | undefined,
  onProgress: ((progress: FranchiseActivitiesProgress) => void) | undefined,
): Promise<FranchiseActivity[]> {
  const nodes = await depaginate<ActivitiesPageResponse, ApiListActivity>({
    query: FRANCHISE_ACTIVITIES_QUERY,
    variables: { userId, mediaIds: [...mediaIds] },
    signal,
    onProgress: (progress: DepaginateProgress) =>
      onProgress?.({ phase: 'fetch', ...progress }),
    selectPage: (data) => ({
      nodes: Array.isArray(data.Page?.activities)
        ? data.Page.activities
        : [],
      pageInfo: {
        hasNextPage: data.Page?.pageInfo?.hasNextPage === true,
        currentPage: data.Page?.pageInfo?.currentPage ?? undefined,
      },
    }),
  });
  const deduplicated = new Map<number, FranchiseActivity>();
  for (const node of nodes) {
    const parsed = parseActivity(node);
    if (parsed) {
      deduplicated.set(parsed.id, parsed);
    }
  }
  return [...deduplicated.values()];
}

export async function fetchFranchiseActivities(
  options: FetchFranchiseActivitiesOptions,
): Promise<FranchiseActivity[]> {
  const username = options.username.trim();
  const mediaIds = [...new Set(options.mediaIds)]
    .filter((mediaId) => Number.isInteger(mediaId) && mediaId > 0)
    .sort((left, right) => left - right);
  if (!username || mediaIds.length === 0) {
    return [];
  }

  options.signal?.throwIfAborted();
  const cachedActivities: FranchiseActivity[] = [];
  const missingMediaIds: number[] = [];
  if (options.forceRefresh) {
    missingMediaIds.push(...mediaIds);
  } else {
    const cacheResults = await Promise.all(
      mediaIds.map(async (mediaId) => ({
        mediaId,
        result: await readFranchiseActivitiesCache(username, mediaId),
      })),
    );
    options.signal?.throwIfAborted();
    for (const { mediaId, result } of cacheResults) {
      if (result.hit) {
        cachedActivities.push(
          ...result.activities.filter(
            (activity) => activity.media.id === mediaId,
          ),
        );
      } else {
        missingMediaIds.push(mediaId);
      }
    }
  }
  options.onProgress?.({
    phase: 'cache',
    cachedMedia: mediaIds.length - missingMediaIds.length,
    totalMedia: mediaIds.length,
  });

  let fetchedActivities: FranchiseActivity[] = [];
  if (missingMediaIds.length > 0) {
    const user = await resolveActivityUser(username, options.signal);
    fetchedActivities = await fetchMissingActivities(
      user.id,
      missingMediaIds,
      options.signal,
      options.onProgress,
    );
    options.signal?.throwIfAborted();

    const byMedia = new Map<number, FranchiseActivity[]>();
    for (const mediaId of missingMediaIds) {
      byMedia.set(mediaId, []);
    }
    for (const activity of fetchedActivities) {
      byMedia.get(activity.media.id)?.push(activity);
    }
    await Promise.all(
      [...byMedia].map(([mediaId, activities]) =>
        writeFranchiseActivitiesCache(username, mediaId, activities),
      ),
    );
    await enforceFranchiseActivitiesCacheBudget(
      franchiseActivitiesCacheKeys(username, mediaIds),
    );
  }

  const deduplicated = new Map<number, FranchiseActivity>();
  for (const activity of [...cachedActivities, ...fetchedActivities]) {
    deduplicated.set(activity.id, activity);
  }
  return [...deduplicated.values()];
}
