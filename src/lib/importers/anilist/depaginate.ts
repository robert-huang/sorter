/**
 * Generic AniList pagination helper — browser port of anilisttools
 * `depaginated_request`. Loops `page` until `pageInfo.hasNextPage` is false.
 */

import { executeAnilistQuery } from './transport';

export const ANILIST_TOOLS_MAX_PAGE_SIZE = 50;

export type DepaginatePageInfo = {
  hasNextPage: boolean;
  currentPage?: number;
};

export type DepaginateProgress = {
  page: number;
  collected: number;
};

export type DepaginateOptions<TData, TNode> = {
  query: string;
  variables?: Record<string, unknown>;
  perPage?: number;
  /** Stop after this many pages (Favourites bounded fetches). */
  maxPages?: number;
  /** Pull nodes + pageInfo from one page's GraphQL `data` payload. */
  selectPage: (data: TData) => { nodes: TNode[]; pageInfo: DepaginatePageInfo };
  signal?: AbortSignal;
  onProgress?: (progress: DepaginateProgress) => void;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Depagination aborted', 'AbortError');
  }
}

/**
 * Fetch every page of a paginated AniList query and return the accumulated
 * nodes. Honors `signal` between page requests.
 */
export async function depaginate<TData, TNode>(
  options: DepaginateOptions<TData, TNode>,
): Promise<TNode[]> {
  const {
    query,
    variables = {},
    perPage = ANILIST_TOOLS_MAX_PAGE_SIZE,
    maxPages,
    selectPage,
    signal,
    onProgress,
  } = options;

  const out: TNode[] = [];
  let page = 1;
  let pagesFetched = 0;

  while (true) {
    throwIfAborted(signal);
    if (maxPages !== undefined && pagesFetched >= maxPages) {
      break;
    }

    const data = await executeAnilistQuery<TData>(query, {
      ...variables,
      page,
      perPage,
    });

    if (!data) {
      break;
    }

    pagesFetched += 1;
    const { nodes, pageInfo } = selectPage(data);
    out.push(...nodes);
    onProgress?.({ page, collected: out.length });

    if (!pageInfo.hasNextPage) {
      break;
    }

    page += 1;
  }

  return out;
}
