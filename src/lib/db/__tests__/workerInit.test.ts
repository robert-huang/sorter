import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcRequest } from '../rpc';

const READY_DELAY_MS = 50;

/**
 * Minimal harness that mirrors worker.ts init-queue behavior without loading WASM.
 */
class InitQueueHarness {
  private sqlite3: object | null = null;
  private readonly pendingRpc: RpcRequest[] = [];
  readonly replies: Array<{ id: number; ok: boolean; error?: { message: string } }> = [];

  constructor() {
    void this.init();
  }

  onMessage(req: RpcRequest): void {
    if (!this.sqlite3) {
      this.pendingRpc.push(req);
      return;
    }
    this.replies.push({ id: req.id, ok: true });
  }

  private async init(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, READY_DELAY_MS));
    this.sqlite3 = {};
    const queued = this.pendingRpc.splice(0, this.pendingRpc.length);
    for (const req of queued) {
      this.replies.push({ id: req.id, ok: true });
    }
  }
}

describe('worker init queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues RPC until init completes instead of rejecting early', async () => {
    const harness = new InitQueueHarness();
    const req: RpcRequest = { id: 1, type: 'open', args: { sourceId: 'test' } };

    harness.onMessage(req);
    expect(harness.replies).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(READY_DELAY_MS);
    await vi.runAllTimersAsync();

    expect(harness.replies).toEqual([{ id: 1, ok: true }]);
  });
});
