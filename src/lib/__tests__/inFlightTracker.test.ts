import { describe, expect, it } from 'vitest';
import { InFlightTracker } from '../inFlightTracker';

describe('InFlightTracker', () => {
  it('first tryAcquire succeeds, second on the same id is a no-op', () => {
    const tracker = new InFlightTracker();
    // The whole point of the gate: this is the rapid-double-click
    // scenario from the Push button. Without the gate the second
    // click would kick off a second cloud upload racing the first.
    expect(tracker.tryAcquire('slot-A')).toBe(true);
    expect(tracker.tryAcquire('slot-A')).toBe(false);
    expect(tracker.has('slot-A')).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it('different ids do not block each other', () => {
    const tracker = new InFlightTracker();
    expect(tracker.tryAcquire('slot-A')).toBe(true);
    expect(tracker.tryAcquire('slot-B')).toBe(true);
    expect(tracker.size).toBe(2);
  });

  it('release lets a subsequent tryAcquire succeed again', () => {
    const tracker = new InFlightTracker();
    tracker.tryAcquire('slot-A');
    tracker.release('slot-A');
    expect(tracker.has('slot-A')).toBe(false);
    // The "second attempt after the first finished" case: a user
    // who clicks Push, waits for it to finish, then clicks again
    // should not be blocked.
    expect(tracker.tryAcquire('slot-A')).toBe(true);
  });

  it('release of an un-held id is a silent no-op', () => {
    const tracker = new InFlightTracker();
    // Defensive: a `finally` block that runs after an unrelated
    // exception path must not throw on a never-acquired id.
    expect(() => tracker.release('never-held')).not.toThrow();
    expect(tracker.size).toBe(0);
  });

  it('snapshot is a defensive copy — mutating it does not affect the tracker', () => {
    const tracker = new InFlightTracker();
    tracker.tryAcquire('slot-A');
    const snap = tracker.snapshot() as Set<string>;
    snap.add('slot-B');
    expect(tracker.has('slot-B')).toBe(false);
    expect(tracker.size).toBe(1);
  });

  it('simulates the double-click-then-finally guard from App.tsx', async () => {
    const tracker = new InFlightTracker();
    let runs = 0;

    async function guarded(id: string): Promise<void> {
      if (!tracker.tryAcquire(id)) return;
      try {
        runs += 1;
        // Yield so a "second click during the await" lands while
        // the first call is still in flight.
        await Promise.resolve();
      } finally {
        tracker.release(id);
      }
    }

    // Fire two clicks before the first one's microtask resolves.
    const p1 = guarded('slot-A');
    const p2 = guarded('slot-A');
    await Promise.all([p1, p2]);

    expect(runs).toBe(1);
    expect(tracker.has('slot-A')).toBe(false);
  });
});
