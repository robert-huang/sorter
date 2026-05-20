/**
 * Tiny re-entrancy gate for "at most one async operation per id at a
 * time" use cases. The original motivation was the per-slot cloud
 * Push/Pull buttons in the gear menu: a fast double-click on the
 * arrow used to fire two concurrent uploads, racing each other's
 * etag check and producing spurious conflict modals. With this gate
 * the second click is a no-op until the first call settles.
 *
 * Pure (no React, no timers, no globals) so it's trivial to unit-
 * test and to share between the App-level handler and any future
 * UI surface that wants the same guard (e.g. a touch-and-hold Push
 * gesture, or a keyboard shortcut).
 *
 * Usage pattern:
 *   const tracker = useRef(new InFlightTracker()).current;
 *   if (!tracker.tryAcquire(id)) return;          // already running
 *   try { await doWork(); } finally { tracker.release(id); }
 *
 * Snapshot() exists so React consumers can hand the current set off
 * to children for "show a spinner / disable the button" rendering
 * without exposing the mutable internal Set. Always returns a fresh
 * copy — callers can treat the returned ReadonlySet as a stable
 * value for the lifetime of the render.
 */
export class InFlightTracker {
  private readonly ids = new Set<string>();

  /**
   * Atomically check-and-add. Returns true if the id was free (and
   * is now claimed by the caller), false if another caller already
   * holds it. Synchronous, so two same-tick double-click handlers
   * see each other's effect deterministically — unlike a React-
   * state-based guard, which would batch the two reads against the
   * same stale snapshot.
   */
  tryAcquire(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    return true;
  }

  /**
   * Release the id so a subsequent tryAcquire can succeed. Always
   * call from a `finally` block so a thrown error doesn't leave the
   * id permanently stuck in the "in flight" state.
   */
  release(id: string): void {
    this.ids.delete(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Immutable snapshot for read-only consumers (e.g. UI rendering). */
  snapshot(): ReadonlySet<string> {
    return new Set(this.ids);
  }

  /** Number of ids currently held. Mostly useful for tests/diagnostics. */
  get size(): number {
    return this.ids.size;
  }
}
