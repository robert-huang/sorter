/**
 * AniList HTTP transport. Implements the contract in AniList plan §D:
 *
 *   - **Sequential queue.** One in-flight request at a time per tab. Not a
 *     pace cap — just "don't open parallel connections." The paginated
 *     import loop is sequential by construction; lazy expansion is one
 *     request per click.
 *   - **Reactive 429 backoff.** Honor `Retry-After` when present
 *     (`(parseInt + 1) * 1000` ms — `+1` is defensive padding inherited
 *     from anilisttools). Else exponential fallback: 1s, 2s, 4s, 8s, 16s.
 *     Hard cap at 5 retries → `RateLimitExceededError`.
 *   - **Fail-fast** on other 4xx (except 404), 5xx, and GraphQL `errors[]`.
 *     404 returns `null` (AniList convention on `Media(id:)` not found).
 *   - **No proactive throttling.** Pacing is purely reactive on 429.
 *     `X-RateLimit-*` headers are *not* tracked — they're not accurate
 *     enough to drive a UI budget display and we have no other consumer.
 *   - **No custom User-Agent.** Browsers block setting it; natural browser
 *     UA + Origin make us indistinguishable from a user opening their list
 *     in a tab.
 *   - **Surface wait state to UI** during backoff so the user sees progress
 *     instead of a frozen spinner (`subscribeToWaitState`).
 *
 * State is module-level (per-tab singleton). The `_resetTransportForTesting`
 * export is the only non-public entry point and is only consumed by tests.
 */

export const ANILIST_GRAPHQL_ENDPOINT = 'https://graphql.anilist.co';
export const ANILIST_MAX_RETRIES = 5;

/** Wait state surfaced to UI subscribers while the transport sleeps on 429. */
export type AnilistWaitState = {
  kind: 'rate-limited';
  /** Milliseconds the transport will sleep before re-issuing the request. */
  retryInMs: number;
  /** 1-indexed retry attempt that will be tried after the sleep. */
  attempt: number;
};

// ──────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────

export class RateLimitExceededError extends Error {
  readonly attempts: number;
  constructor(attempts: number) {
    super(
      `AniList rate-limited the request after ${attempts} retries — try again in a few minutes.`,
    );
    this.name = 'RateLimitExceededError';
    this.attempts = attempts;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  constructor(status: number, statusText: string) {
    super(`AniList HTTP ${status} ${statusText}`);
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
  }
}

/** Shape of an individual entry in the GraphQL `errors[]` array. */
export type AnilistGraphQLErrorEntry = {
  message: string;
  status?: number;
  locations?: Array<{ line: number; column: number }>;
};

export class GraphQLError extends Error {
  readonly errors: AnilistGraphQLErrorEntry[];
  constructor(errors: AnilistGraphQLErrorEntry[]) {
    const first = errors[0]?.message ?? 'unknown';
    super(`AniList GraphQL error: ${first}`);
    this.name = 'GraphQLError';
    this.errors = errors;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Module state
// ──────────────────────────────────────────────────────────────────────

/**
 * Queue tail. Each new request awaits this before starting, then replaces
 * it with its own (error-swallowed) completion promise. The swallow is
 * important: one failed request shouldn't poison the queue for subsequent
 * callers (they'd get a stale rejection).
 */
let queueTail: Promise<unknown> = Promise.resolve();

const waitListeners = new Set<(state: AnilistWaitState | null) => void>();

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/**
 * Run a GraphQL query through the AniList endpoint. Always serialized
 * behind any prior in-flight request.
 *
 *   - Returns `data` from the response body on 2xx with no `errors[]`.
 *   - Returns `null` on 404 (treat as "not found").
 *   - Retries on 429 up to {@link ANILIST_MAX_RETRIES} times, honoring
 *     `Retry-After` when present.
 *   - Throws {@link HttpError} on other 4xx/5xx.
 *   - Throws {@link GraphQLError} when the response body has `errors[]`.
 *   - Throws {@link RateLimitExceededError} after the retry cap.
 */
export function executeAnilistQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T | null> {
  return enqueue(() => runOnce<T>(query, variables));
}

/**
 * Subscribe to wait-state changes. `state` is non-null while the transport
 * is sleeping on a 429 retry, and `null` immediately after the sleep ends
 * (regardless of whether the next attempt succeeds). Returns an unsubscribe
 * function.
 */
export function subscribeToWaitState(
  listener: (state: AnilistWaitState | null) => void,
): () => void {
  waitListeners.add(listener);
  return () => waitListeners.delete(listener);
}

/** Test-only: reset module state between tests. */
export function _resetTransportForTesting(): void {
  queueTail = Promise.resolve();
  waitListeners.clear();
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queueTail.then(fn, fn);
  // Swallow errors when *reading* the tail so the next caller doesn't get a
  // stale rejection; the original promise still surfaces the error to the
  // caller that requested this enqueue.
  queueTail = result.then(noop, noop);
  return result;
}

function noop(): void {
  /* intentional */
}

async function runOnce<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  let attempt = 0;
  while (true) {
    const response = await fetch(ANILIST_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429) {
      attempt += 1;
      if (attempt > ANILIST_MAX_RETRIES) {
        throw new RateLimitExceededError(attempt - 1);
      }
      const waitMs = computeBackoffMs(response.headers.get('Retry-After'), attempt);
      notifyWait({ kind: 'rate-limited', retryInMs: waitMs, attempt });
      try {
        await delay(waitMs);
      } finally {
        notifyWait(null);
      }
      continue;
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new HttpError(response.status, response.statusText);
    }

    const body = (await response.json()) as {
      data?: T;
      errors?: AnilistGraphQLErrorEntry[];
    };

    if (body.errors && body.errors.length > 0) {
      throw new GraphQLError(body.errors);
    }

    return (body.data ?? null) as T | null;
  }
}

/**
 * Compute the milliseconds to sleep before the next attempt.
 *
 *   - If `Retry-After` is a valid integer (seconds), use `(N + 1) * 1000`.
 *     The `+1` is defensive padding inherited from anilisttools — accounts
 *     for clock skew and AniList rounding down their bucket reset.
 *   - Else fall back to exponential: `2^(attempt - 1)` seconds
 *     → 1s, 2s, 4s, 8s, 16s for attempts 1..5.
 */
export function computeBackoffMs(retryAfterHeader: string | null, attempt: number): number {
  if (retryAfterHeader !== null) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return (seconds + 1) * 1000;
    }
  }
  return Math.pow(2, attempt - 1) * 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyWait(state: AnilistWaitState | null): void {
  for (const listener of waitListeners) {
    try {
      listener(state);
    } catch {
      // Subscriber errors must not crash the transport; swallow.
    }
  }
}
