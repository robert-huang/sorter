import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircularArrowGlyph } from '../components/CircularArrowGlyph';
import { RemoveGlyph } from '../components/RemoveGlyph';
import { normalizeQuery, readCachedQueryMatch, type QueryMatch } from './toolQueryCache';

export type QueryRowState =
  | { kind: 'new' }
  | { kind: 'loading' }
  | { kind: 'resolved'; match: QueryMatch }
  | { kind: 'error'; message: string };

/** Persisted `stagedQueries`: trimmed, non-empty strings, case-insensitively unique. */
export function normalizeStagedQueries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return mergeStagedQueries([], strings);
}

/** Queries Compare runs: staged first, then textarea lines not already staged. */
export function pendingQueries(staged: readonly string[], lines: readonly string[]): string[] {
  return mergeStagedQueries(staged, lines).slice(staged.length);
}

/** Append `incoming` to `staged`, skipping queries already present (case-insensitive). */
export function mergeStagedQueries(staged: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(staged.map(normalizeQuery));
  const out = [...staged];
  for (const query of incoming) {
    const key = normalizeQuery(query);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

/**
 * Per-row resolution state keyed by cache key. New keys are looked up in
 * the query cache only (never AniList); callers set results after a
 * Compare or refresh via `setRowState`.
 */
export function useQueryRowStates(keys: readonly string[]) {
  const [states, setStates] = useState<Record<string, QueryRowState>>({});
  const requestedRef = useRef(new Set<string>());
  const keysSignature = keys.join('\n');

  useEffect(() => {
    for (const key of keys) {
      if (requestedRef.current.has(key)) continue;
      requestedRef.current.add(key);
      void readCachedQueryMatch(key).then((match) => {
        setStates((prev) =>
          prev[key] && prev[key].kind !== 'new'
            ? prev
            : { ...prev, [key]: match ? { kind: 'resolved', match } : { kind: 'new' } },
        );
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSignature]);

  const setRowState = useCallback((key: string, state: QueryRowState) => {
    requestedRef.current.add(key);
    setStates((prev) => ({ ...prev, [key]: state }));
  }, []);

  const stateFor = useCallback(
    (key: string): QueryRowState => states[key] ?? { kind: 'new' },
    [states],
  );

  return { stateFor, setRowState };
}

function RowResolution({
  state,
  renderMatch,
}: {
  state: QueryRowState;
  renderMatch: (match: QueryMatch) => ReactNode;
}) {
  switch (state.kind) {
    case 'resolved':
      return <>{renderMatch(state.match)}</>;
    case 'loading':
      return <span className="tool-query-staging-new">Searching…</span>;
    case 'error':
      return (
        <span className="tool-error" title={state.message}>
          {state.message}
        </span>
      );
    default:
      return (
        <span
          className="tool-query-staging-new"
          title="No cached match yet — resolved from AniList on the next Compare"
        >
          new
        </span>
      );
  }
}

export function ToolQueryStagingList({
  staged,
  pending,
  stateFor,
  keyFor,
  renderMatch,
  onRefresh,
  onRemove,
  onClear,
  disabled,
  emptyHint,
}: {
  staged: readonly string[];
  /** Textarea lines not yet added; included in Compare, shown faded. */
  pending: readonly string[];
  stateFor: (key: string) => QueryRowState;
  keyFor: (query: string) => string;
  renderMatch: (match: QueryMatch) => ReactNode;
  onRefresh: (query: string) => void;
  onRemove: (query: string) => void;
  onClear: () => void;
  disabled?: boolean;
  emptyHint: string;
}) {
  if (staged.length === 0 && pending.length === 0) {
    return (
      <div className="staged-panel empty tool-query-staging" aria-live="polite">
        <span className="staged-panel-empty-hint">{emptyHint}</span>
      </div>
    );
  }
  const rows = [
    ...staged.map((query) => ({ query, isPending: false })),
    ...pending.map((query) => ({ query, isPending: true })),
  ];
  return (
    <div className="staged-panel tool-query-staging">
      <div className="staged-panel-header">
        <div className="staged-panel-summary">
          <strong>{staged.length}</strong> staged
          {pending.length > 0 && <> · {pending.length} pending</>}
        </div>
        {staged.length > 0 && (
          <div className="staged-panel-actions">
            <button
              type="button"
              className="btn btn-small"
              disabled={disabled}
              onClick={onClear}
              title="Remove every staged query"
            >
              Clear staged
            </button>
          </div>
        )}
      </div>
      <ul className="tool-query-staging-list">
        {rows.map(({ query, isPending }) => {
          const state = stateFor(keyFor(query));
          return (
            <li
              key={`${isPending ? 'pending' : 'staged'}:${query}`}
              className={`tool-query-staging-row${isPending ? ' pending' : ''}`}
            >
              <span className="tool-query-staging-query" title={query}>
                {query}
              </span>
              <span className="tool-query-staging-match">
                <RowResolution state={state} renderMatch={renderMatch} />
              </span>
              {isPending && (
                <span
                  className="staged-panel-pending-marker"
                  title="Still in the textarea — click Add to staged, or just Compare to include it"
                >
                  pending
                </span>
              )}
              <button
                type="button"
                className="btn icon-only tool-query-staging-refresh"
                disabled={disabled || state.kind === 'loading'}
                onClick={() => onRefresh(query)}
                title={`Search AniList again for "${query}"`}
                aria-label={`Refresh ${query}`}
              >
                <CircularArrowGlyph />
              </button>
              {!isPending && (
                <button
                  type="button"
                  className="x-button tool-query-staging-remove"
                  disabled={disabled}
                  onClick={() => onRemove(query)}
                  title="Remove from staged"
                  aria-label={`Remove ${query}`}
                >
                  <RemoveGlyph size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
