/**
 * Dependency-injection seam for the AniList importer modules.
 *
 * Production callers build a context via {@link makeAnilistImportContext},
 * which wires:
 *   - `executeQuery` → the singleton sequential transport in `transport.ts`
 *   - `db.exec` / `db.execBatch` → the worker-mediated client in `db/client.ts`
 *     (curried with `ANILIST_SOURCE_ID`)
 *   - `now` → `Date.now`
 *
 * Tests build a context with:
 *   - `executeQuery` → a `vi.fn()` that returns shaped responses
 *   - `db` → an adapter over an in-memory SQLite connection (sync exec
 *     wrapped in `Promise.resolve` to match the async interface)
 *   - `now` → an injected clock so timestamps are deterministic
 *
 * The autopush / dirty hooks live here too so the importer layer never
 * imports the cloud layer directly — wiring lives at the App level and
 * can swap the hook (e.g. delay autopush, queue dirty work, etc.).
 */

import * as client from '../../db/client';
import type { DbRow, SqlParam } from '../../db/rpc';
import { ANILIST_SOURCE_ID } from './anilistSource';
import {
  AnilistAuthRequiredError,
  getAnilistAccount,
  isAnilistAuthFailure,
  markAnilistAccountInvalid,
} from './anilistAuth';
import type { AnilistProgressReporter } from './progress';
import type { MediaThemeSongsPayload } from './themeSongs/types';
import { executeAnilistQuery, type ExecuteAnilistQueryOptions } from './transport';

export type SqlBindable = SqlParam;

export interface AnilistDbExecutor {
  exec(sql: string, params?: readonly SqlBindable[]): Promise<DbRow[]>;
  execBatch(
    statements: ReadonlyArray<{ sql: string; params?: readonly SqlBindable[] }>,
  ): Promise<void>;
}

/** Keep worker `execBatch` RPC payloads under structured-clone limits. */
export const DEFAULT_EXEC_BATCH_CHUNK_SIZE = 500;

export async function execBatchInChunks(
  db: AnilistDbExecutor,
  statements: ReadonlyArray<{ sql: string; params?: readonly SqlBindable[] }>,
  chunkSize = DEFAULT_EXEC_BATCH_CHUNK_SIZE,
): Promise<void> {
  if (statements.length === 0) {
    return;
  }
  for (let offset = 0; offset < statements.length; offset += chunkSize) {
    await db.execBatch(statements.slice(offset, offset + chunkSize));
  }
}

export type AnilistExecuteQuery = <T>(
  query: string,
  variables: Record<string, unknown>,
) => Promise<T | null>;

export type AnilistDbChange =
  | {
      kind: 'media-theme-songs';
      mediaId: number;
      payload: MediaThemeSongsPayload;
    }
  | { kind: 'unrelated' };

export interface AnilistImportContext {
  executeQuery: AnilistExecuteQuery;
  db: AnilistDbExecutor;
  now: () => number;
  /**
   * Hook fired by importers that need to push `anilist.sqlite` to Drive
   * on successful completion (list import, favourites import). The Phase D
   * cloud panel wires this; in v1 the default is a no-op so the importer
   * can run standalone.
   */
  onAutoPushRequested?: () => Promise<void> | void;
  /**
   * Hook fired by ad-hoc DB writes that bypass full-refresh autopush
   * (lazy detail expansion, per-entry refresh). The Phase D cloud panel
   * increments a "N pending changes" counter from here.
   */
  onDirtyIncrement?: (change?: AnilistDbChange) => Promise<void> | void;
  /**
   * Synchronous progress callback fired by importers so the UI can
   * surface "fetching page 3…" / "writing 412 rows…" instead of a
   * dead spinner. Optional — importers behave identically when unset.
   * Per-event semantics live in {@link AnilistProgressEvent}.
   */
  onProgress?: AnilistProgressReporter;
}

export type MakeAnilistImportContextOptions = Partial<AnilistImportContext> & {
  accessToken?: string;
  /** When set, auth failures mark this account invalid before re-throwing. */
  authFailureUserId?: number;
};

function bindAccessTokenToExecuteQuery(
  accessToken: string,
  authFailureUserId?: number,
): AnilistExecuteQuery {
  return async <T>(query: string, variables: Record<string, unknown>) => {
    const options: ExecuteAnilistQueryOptions = { accessToken };
    try {
      return await executeAnilistQuery<T>(query, variables, options);
    } catch (err) {
      if (isAnilistAuthFailure(err)) {
        if (authFailureUserId != null) {
          markAnilistAccountInvalid(authFailureUserId);
        }
        const account =
          authFailureUserId != null ? getAnilistAccount(authFailureUserId) : null;
        throw new AnilistAuthRequiredError(account?.userName ?? 'your account');
      }
      throw err;
    }
  };
}

/**
 * Production context wired to the real transport + worker-mediated DB
 * client. Pass overrides to swap individual deps (e.g. inject an autopush
 * hook from the App layer).
 */
export function makeAnilistImportContext(
  overrides: MakeAnilistImportContextOptions = {},
): AnilistImportContext {
  const { accessToken, authFailureUserId, ...rest } = overrides;
  const sourceId = ANILIST_SOURCE_ID;
  const baseExecuteQuery: AnilistExecuteQuery = accessToken
    ? bindAccessTokenToExecuteQuery(accessToken, authFailureUserId)
    : executeAnilistQuery;
  return {
    executeQuery: baseExecuteQuery,
    db: {
      exec: (sql, params) =>
        client.exec(sourceId, sql, params ? [...params] : undefined),
      execBatch: (statements) =>
        client.execBatch(
          sourceId,
          statements.map((s) => ({ sql: s.sql, params: s.params ? [...s.params] : undefined })),
        ),
    },
    now: () => Date.now(),
    ...rest,
  };
}
