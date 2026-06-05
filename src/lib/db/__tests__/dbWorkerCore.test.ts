import { describe, expect, it } from 'vitest';

/**
 * Regression tests for worker init gating logic (no WASM).
 * The harness mirrors {@link queueRpc} / drain behavior from dbWorkerCore.
 */
describe('dbWorkerCore init gating', () => {
  it('RPCs queued until workerInitComplete, not when sqlite3 is set early', async () => {
    let sqlite3: object | null = null;
    let workerInitComplete = false;
    const pending: Array<{ id: number }> = [];
    const executed: number[] = [];

    const queue = (req: { id: number }) => {
      if (!workerInitComplete) {
        pending.push(req);
        return;
      }
      executed.push(req.id);
    };

    queue({ id: 1 });
    expect(executed).toEqual([]);

    sqlite3 = {};
    queue({ id: 2 });
    expect(executed).toEqual([]);

    workerInitComplete = true;
    for (const req of pending.splice(0)) {
      queue(req);
    }
    queue({ id: 3 });

    expect(sqlite3).not.toBeNull();
    expect(executed).toEqual([1, 2, 3]);
  });
});
