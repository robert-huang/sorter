import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANILIST_GRAPHQL_ENDPOINT,
  ANILIST_MAX_RETRIES,
  GraphQLError,
  HttpError,
  RateLimitExceededError,
  _resetTransportForTesting,
  computeBackoffMs,
  executeAnilistQuery,
  subscribeToWaitState,
  type AnilistWaitState,
} from '../transport';

type RequestInitJson = { method?: string; headers?: HeadersInit; body?: string };

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : `status-${status}`,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeFetchMock(responses: Response[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error('fetch mock exhausted');
    }
    return next;
  });
}

beforeEach(() => {
  _resetTransportForTesting();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('executeAnilistQuery — happy path', () => {
  it('POSTs query + variables JSON to the AniList endpoint with the documented headers', async () => {
    const fetchMock = makeFetchMock([jsonResponse(200, { data: { Page: { x: 1 } } })]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeAnilistQuery<{ Page: { x: number } }>('query Q { x }', {
      a: 1,
    });

    expect(result).toEqual({ Page: { x: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInitJson];
    expect(url).toBe(ANILIST_GRAPHQL_ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Accept')).toBe('application/json');
    expect(JSON.parse(init.body ?? '')).toEqual({
      query: 'query Q { x }',
      variables: { a: 1 },
    });
  });

  it('returns null for a 404 (AniList "not found" convention)', async () => {
    vi.stubGlobal('fetch', makeFetchMock([jsonResponse(404, { errors: [{ message: 'not found' }] })]));
    const result = await executeAnilistQuery('query Q { x }', {});
    expect(result).toBeNull();
  });
});

describe('executeAnilistQuery — sequential queue', () => {
  it('serializes overlapping calls so the second fetch starts only after the first resolves', async () => {
    let resolveFirst!: (r: Response) => void;
    const firstPromise = new Promise<Response>((r) => (resolveFirst = r));
    const calls: number[] = [];
    const fetchMock = vi.fn(async () => {
      calls.push(Date.now());
      if (fetchMock.mock.calls.length === 1) return firstPromise;
      return jsonResponse(200, { data: { which: 'second' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstP = executeAnilistQuery('q1', {});
    const secondP = executeAnilistQuery('q2', {});

    // Let microtasks settle. Only the first request should have been issued —
    // the second is parked behind the queue tail until firstP resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst(jsonResponse(200, { data: { which: 'first' } }));

    const [firstResult, secondResult] = await Promise.all([firstP, secondP]);
    expect(firstResult).toEqual({ which: 'first' });
    expect(secondResult).toEqual({ which: 'second' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failure in one request does not poison the queue for the next', async () => {
    const fetchMock = makeFetchMock([
      jsonResponse(500, { errors: [{ message: 'server died' }] }),
      jsonResponse(200, { data: { ok: true } }),
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const firstP = executeAnilistQuery('q1', {});
    const secondP = executeAnilistQuery('q2', {});

    await expect(firstP).rejects.toBeInstanceOf(HttpError);
    const second = await secondP;
    expect(second).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('executeAnilistQuery — 429 backoff', () => {
  it('honors a numeric Retry-After header with the documented +1s padding', async () => {
    vi.useFakeTimers();
    const fetchMock = makeFetchMock([
      jsonResponse(429, { errors: [{ message: 'rate limit' }] }, { 'Retry-After': '5' }),
      jsonResponse(200, { data: { ok: 1 } }),
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const promise = executeAnilistQuery('q', {});
    // Let the first fetch resolve and the backoff sleep be scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Retry-After: 5  →  (5 + 1) * 1000 = 6000ms before the next attempt.
    await vi.advanceTimersByTimeAsync(5999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toEqual({ ok: 1 });
  });

  it('uses a 61s floor on the first retry when Retry-After is missing (browser-CORS-friendly default)', async () => {
    vi.useFakeTimers();
    const fetchMock = makeFetchMock([
      jsonResponse(429, { errors: [{ message: 'rl' }] }),
      jsonResponse(200, { data: { ok: 1 } }),
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const promise = executeAnilistQuery('q', {});
    await vi.advanceTimersByTimeAsync(0);
    // First-retry floor is 61_000ms — AniList's 60s rate-limit window
    // plus 1s padding. `Retry-After` is unreadable from browser JS
    // (CORS), so we conservatively wait out the window on the first
    // retry; subsequent retries drop back to short exponential.
    await vi.advanceTimersByTimeAsync(60_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toEqual({ ok: 1 });
  });

  it('uses an unparseable Retry-After as a missing header (61s floor on first retry)', async () => {
    vi.useFakeTimers();
    const fetchMock = makeFetchMock([
      jsonResponse(429, { errors: [] }, { 'Retry-After': 'tomorrow' }),
      jsonResponse(200, { data: { ok: 1 } }),
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const promise = executeAnilistQuery('q', {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(promise).resolves.toEqual({ ok: 1 });
  });

  it('throws RateLimitExceededError after exhausting the retry cap', async () => {
    vi.useFakeTimers();
    // First fetch + ANILIST_MAX_RETRIES retries (all 429) = MAX + 1 calls.
    const responses = Array.from({ length: ANILIST_MAX_RETRIES + 1 }, () =>
      jsonResponse(429, { errors: [{ message: 'rl' }] }),
    );
    vi.stubGlobal('fetch', makeFetchMock(responses));

    const promise = executeAnilistQuery('q', {});

    // Drive the timers past every fallback backoff slot. Total wait
    // across 5 retries is 61 + 2 + 4 + 8 + 16 = 91_000ms. Advance well
    // past that so the 6th 429 has fired and the cap rejection is
    // queued.
    await vi.advanceTimersByTimeAsync(120_000);

    await expect(promise).rejects.toBeInstanceOf(RateLimitExceededError);
  });
});

describe('executeAnilistQuery — fail-fast paths', () => {
  it('throws HttpError on non-429 4xx without retry', async () => {
    const fetchMock = makeFetchMock([jsonResponse(403, { errors: [{ message: 'denied' }] })]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeAnilistQuery('q', {})).rejects.toMatchObject({
      name: 'HttpError',
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws HttpError on 5xx without retry', async () => {
    const fetchMock = makeFetchMock([jsonResponse(503, { errors: [{ message: 'down' }] })]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeAnilistQuery('q', {})).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws GraphQLError when the 2xx body has a populated errors[] array', async () => {
    const fetchMock = makeFetchMock([
      jsonResponse(200, {
        data: null,
        errors: [
          { message: 'User not found', status: 404 },
          { message: 'private list' },
        ],
      }),
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const error = await executeAnilistQuery('q', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).errors).toHaveLength(2);
    expect((error as GraphQLError).errors[0].message).toBe('User not found');
  });
});

describe('wait-state subscribers', () => {
  it('notifies subscribers with a wait state during 429 backoff, then clears it', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      makeFetchMock([
        jsonResponse(429, { errors: [{ message: 'rl' }] }, { 'Retry-After': '2' }),
        jsonResponse(200, { data: { ok: 1 } }),
      ]),
    );
    const events: Array<AnilistWaitState | null> = [];
    subscribeToWaitState((s) => events.push(s));

    const promise = executeAnilistQuery('q', {});
    await vi.advanceTimersByTimeAsync(0);
    // After the first fetch resolves and before the sleep ends, subscribers
    // should have received exactly one rate-limited notification.
    expect(events).toEqual([
      { kind: 'rate-limited', retryInMs: 3000, attempt: 1 },
    ]);

    await vi.advanceTimersByTimeAsync(3000);
    await promise;
    expect(events).toEqual([
      { kind: 'rate-limited', retryInMs: 3000, attempt: 1 },
      null,
    ]);
  });

  it('returns an unsubscribe function that removes the listener', async () => {
    vi.stubGlobal('fetch', makeFetchMock([jsonResponse(200, { data: {} })]));
    const events: Array<AnilistWaitState | null> = [];
    const unsubscribe = subscribeToWaitState((s) => events.push(s));
    unsubscribe();
    await executeAnilistQuery('q', {});
    expect(events).toEqual([]);
  });
});

describe('computeBackoffMs (unit)', () => {
  it('uses (Retry-After + 1) * 1000 when the header is a non-negative integer', () => {
    expect(computeBackoffMs('0', 1)).toBe(1000);
    expect(computeBackoffMs('5', 1)).toBe(6000);
    expect(computeBackoffMs('30', 5)).toBe(31_000);
  });

  it('uses a 61s floor on the first retry and short exponential after', () => {
    // First retry: 60s window (per AniList's documented rate-limit) + 1s
    // padding. The actual Retry-After header is hidden from browser JS by
    // CORS, hence the floor. Subsequent retries assume the window already
    // rolled over and use the short 2^(attempt-1) ladder to keep total
    // wall-clock bounded (~91s across 5 retries).
    expect(computeBackoffMs(null, 1)).toBe(61_000);
    expect(computeBackoffMs(null, 2)).toBe(2_000);
    expect(computeBackoffMs(null, 3)).toBe(4_000);
    expect(computeBackoffMs(null, 4)).toBe(8_000);
    expect(computeBackoffMs(null, 5)).toBe(16_000);
    expect(computeBackoffMs('not-a-number', 2)).toBe(2_000);
    expect(computeBackoffMs('-5', 1)).toBe(61_000);
  });
});
