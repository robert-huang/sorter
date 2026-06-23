import { afterEach, describe, expect, it, vi } from 'vitest';
import { depaginate } from '../depaginate';
import { _resetTransportForTesting, executeAnilistQuery } from '../transport';

vi.mock('../transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport')>();
  return {
    ...actual,
    executeAnilistQuery: vi.fn(),
  };
});

const mockQuery = vi.mocked(executeAnilistQuery);

type PageData = {
  Page: {
    pageInfo: { hasNextPage: boolean; currentPage: number };
    media: Array<{ id: number }>;
  };
};

describe('depaginate', () => {
  afterEach(() => {
    vi.clearAllMocks();
    _resetTransportForTesting();
  });

  it('accumulates nodes across pages until hasNextPage is false', async () => {
    mockQuery
      .mockResolvedValueOnce({
        Page: {
          pageInfo: { hasNextPage: true, currentPage: 1 },
          media: [{ id: 1 }, { id: 2 }],
        },
      })
      .mockResolvedValueOnce({
        Page: {
          pageInfo: { hasNextPage: false, currentPage: 2 },
          media: [{ id: 3 }],
        },
      });

    const nodes = await depaginate<PageData, { id: number }>({
      query: 'query { ... }',
      variables: { search: 'test' },
      selectPage: (data) => ({
        nodes: data.Page.media,
        pageInfo: data.Page.pageInfo,
      }),
    });

    expect(nodes).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery).toHaveBeenNthCalledWith(1, 'query { ... }', {
      search: 'test',
      page: 1,
      perPage: 50,
    });
    expect(mockQuery).toHaveBeenNthCalledWith(2, 'query { ... }', {
      search: 'test',
      page: 2,
      perPage: 50,
    });
  });

  it('stops when the response data is null', async () => {
    mockQuery.mockResolvedValueOnce(null);

    const nodes = await depaginate<PageData, { id: number }>({
      query: 'q',
      selectPage: (data) => ({
        nodes: data.Page.media,
        pageInfo: data.Page.pageInfo,
      }),
    });

    expect(nodes).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('throws AbortError when aborted between pages', async () => {
    const controller = new AbortController();
    mockQuery.mockResolvedValueOnce({
      Page: {
        pageInfo: { hasNextPage: true, currentPage: 1 },
        media: [{ id: 1 }],
      },
    });
    controller.abort();

    await expect(
      depaginate<PageData, { id: number }>({
        query: 'q',
        signal: controller.signal,
        selectPage: (data) => ({
          nodes: data.Page.media,
          pageInfo: data.Page.pageInfo,
        }),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
