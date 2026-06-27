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
  /** Optional Bearer token for authenticated list queries. */
  accessToken?: string;
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

export type DepaginateResult<TNode> = {
  nodes: TNode[];
  /** True iff the loop stopped because `maxPages` was hit while AniList still reported more pages. */
  truncated: boolean;
  pagesFetched: number;
};

/**
 * Same as {@link depaginate} but also reports whether the loop stopped
 * early because of `maxPages`. Use when a bounded fetch needs to surface
 * partial-data warnings instead of silently under-reporting.
 */
export async function depaginateWithMeta<TData, TNode>(
  options: DepaginateOptions<TData, TNode>,
): Promise<DepaginateResult<TNode>> {
  const {
    query,
    variables = {},
    perPage = ANILIST_TOOLS_MAX_PAGE_SIZE,
    maxPages,
    accessToken,
    selectPage,
    signal,
    onProgress,
  } = options;

  const out: TNode[] = [];
  let page = 1;
  let pagesFetched = 0;
  let truncated = false;

  while (true) {
    throwIfAborted(signal);
    if (maxPages !== undefined && pagesFetched >= maxPages) {
      // We were going to fetch another page but the cap stopped us.
      // The previous iteration's pageInfo had hasNextPage=true, so flag
      // truncation. (We break before pageInfo check so the flag was
      // already set below if hasNextPage was false.)
      break;
    }

    const pageVariables = { ...variables, page, perPage };
    const data = accessToken
      ? await executeAnilistQuery<TData>(query, pageVariables, { accessToken })
      : await executeAnilistQuery<TData>(query, pageVariables);

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

    if (maxPages !== undefined && pagesFetched >= maxPages) {
      // hasNextPage=true but we just hit the cap — partial data.
      truncated = true;
      break;
    }

    page += 1;
  }

  return { nodes: out, truncated, pagesFetched };
}

/**
 * Fetch every page of a paginated AniList query and return the accumulated
 * nodes. Honors `signal` between page requests.
 */
export async function depaginate<TData, TNode>(
  options: DepaginateOptions<TData, TNode>,
): Promise<TNode[]> {
  const { nodes } = await depaginateWithMeta(options);
  return nodes;
}
