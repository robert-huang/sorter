/**
 * AniList HTTP transport. Implements the contract in AniList plan §D:
 *
 *   - **Sequential queue.** One in-flight request at a time per tab. Not a
 *     pace cap — just "don't open parallel connections." The paginated
 *     import loop is sequential by construction; lazy expansion is one
 *     request per click.
 *   - **Reactive 429 backoff.** Honor `Retry-After` when present
 *     (`(parseInt + 1) * 1000` ms — `+1` is defensive padding inherited
 *     from anilisttools). Else fall back to 61s on the first retry
 *     (AniList's 60s window + 1s pad) then short exponential 2s, 4s,
 *     8s, 16s — total wall-clock ≈ 91s. The first-retry floor exists
 *     because browser CORS strips `Retry-After` from cross-origin
 *     response headers and we can't read it from JS unless AniList opts
 *     it into `Access-Control-Expose-Headers`, which they don't. Hard
 *     cap at 5 retries → `RateLimitExceededError`.
 *   - **Network-layer retries.** `fetch()` rejections (TypeError
 *     "Failed to fetch" — Cloudflare RST after a 429, CORS preflight
 *     failure, mid-stream body drop) share the same retry budget and
 *     backoff ladder as 429. If we exhaust the budget on network
 *     failures, the original `TypeError` propagates so the UI shows the
 *     real cause. The shared budget is intentional: a request that
 *     gets a 429 then a connection drop has already burned at least 60s
 *     of wait time, and stacking another full ladder on top would let
 *     a single transient outage hang the import for many minutes.
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
export type ExecuteAnilistQueryOptions = {
  accessToken?: string;
};

export function executeAnilistQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
  options: ExecuteAnilistQueryOptions = {},
): Promise<T | null> {
  return enqueue(() => runOnce<T>(query, variables, options));
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
  options: ExecuteAnilistQueryOptions = {},
): Promise<T | null> {
  let attempt = 0;
  while (true) {
    // Network-layer attempt. `fetch()` can reject with a TypeError
    // ("Failed to fetch") when the browser refuses or the upstream
    // (Cloudflare, in AniList's case) drops the TCP connection — which
    // we've observed happening on the retry that immediately follows a
    // 429, presumably because Cloudflare keeps the throttle active a
    // little past AniList's own 60s window. Same thing can happen when
    // the response body parses partially and then the connection drops
    // mid-stream — `response.json()` rejects with a TypeError too. Both
    // of those should be treated as retryable on the SAME backoff
    // ladder we use for 429, otherwise a single transient drop kills
    // the entire import even though the next attempt would succeed.
    let response: Response;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (options.accessToken) {
        headers.Authorization = `Bearer ${options.accessToken}`;
      }
      response = await fetch(ANILIST_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      const shouldRetry = await handleTransientFailure(attempt + 1);
      if (!shouldRetry) throw cause;
      attempt += 1;
      continue;
    }

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

    let body: { data?: T; errors?: AnilistGraphQLErrorEntry[] };
    try {
      body = (await response.json()) as {
        data?: T;
        errors?: AnilistGraphQLErrorEntry[];
      };
    } catch (cause) {
      const shouldRetry = await handleTransientFailure(attempt + 1);
      if (!shouldRetry) throw cause;
      attempt += 1;
      continue;
    }

    if (body.errors && body.errors.length > 0) {
      throw new GraphQLError(body.errors);
    }

    return (body.data ?? null) as T | null;
  }
}

/**
 * Shared backoff for network-layer failures (fetch/json rejections).
 * Returns `true` if the caller should continue the retry loop, or
 * `false` if the retry budget is exhausted and the original error
 * should propagate. Always uses the no-header backoff branch since a
 * fetch rejection means we never got a response, so no `Retry-After`
 * is available.
 */
async function handleTransientFailure(nextAttempt: number): Promise<boolean> {
  if (nextAttempt > ANILIST_MAX_RETRIES) return false;
  const waitMs = computeBackoffMs(null, nextAttempt);
  notifyWait({ kind: 'rate-limited', retryInMs: waitMs, attempt: nextAttempt });
  try {
    await delay(waitMs);
  } finally {
    notifyWait(null);
  }
  return true;
}

/**
 * Compute the milliseconds to sleep before the next attempt.
 *
 *   - If `Retry-After` is a valid integer (seconds), use `(N + 1) * 1000`.
 *     The `+1` is defensive padding inherited from anilisttools — accounts
 *     for clock skew and AniList rounding down their bucket reset.
 *   - Else (the common case in a browser — see below) the first retry
 *     uses a 61-second floor and subsequent retries use the short
 *     exponential `2^(attempt-1)` seconds: 61s, 2s, 4s, 8s, 16s (≈91s
 *     total across the 5-retry cap).
 *
 * **Why 61s on the first retry.** AniList's documented rate-limit window
 * is 60 seconds, and they DO send a `Retry-After: <seconds>` header on a
 * 429. But the browser's CORS layer hides response headers from
 * JavaScript unless they're either CORS-safelisted (Cache-Control,
 * Content-Language, Content-Type, Expires, Last-Modified, Pragma) or
 * explicitly listed in the server's `Access-Control-Expose-Headers`.
 * AniList does not expose `Retry-After`, so `response.headers.get(...)`
 * returns null in a browser even though DevTools sees the header on the
 * wire. Without that signal, the safe first-retry wait is the documented
 * 60s window plus a 1s padding for clock skew. A short 1s/2s/4s ladder
 * would have fired entirely inside that window and earned another 429
 * every time, which is exactly what we were seeing.
 *
 * **Why short exponential after that.** Once the first 61s wait has
 * elapsed the rate-limit window has rolled over. Any remaining 429s are
 * either transient noise or a sign that AniList is genuinely capping us
 * (in which case more waiting won't help). Short retries keep the total
 * wall-clock bounded (~91s) so the user fails fast instead of staring at
 * a 5-minute frozen UI.
 */
export function computeBackoffMs(retryAfterHeader: string | null, attempt: number): number {
  if (retryAfterHeader !== null) {
    const seconds = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return (seconds + 1) * 1000;
    }
  }
  if (attempt === 1) return 61_000;
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
