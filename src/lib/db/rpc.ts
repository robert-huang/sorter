export type SqlParam = string | number | null | Uint8Array;

export type DbRow = Record<string, string | number | null | Uint8Array>;

export type RpcRequest =
  | { id: number; type: 'open'; args: { sourceId: string } }
  | { id: number; type: 'exec'; args: { sourceId: string; sql: string; params?: SqlParam[] } }
  | {
      id: number;
      type: 'execBatch';
      args: { sourceId: string; statements: Array<{ sql: string; params?: SqlParam[] }> };
    }
  | { id: number; type: 'pullMerge'; args: { sourceId: string; remoteBytes: Uint8Array } }
  | { id: number; type: 'exportBytes'; args: { sourceId: string } }
  | { id: number; type: 'importBytes'; args: { sourceId: string; bytes: Uint8Array } }
  | { id: number; type: 'currentSchemaVersion'; args: { sourceId: string } }
  | { id: number; type: 'peekRemoteSchemaVersion'; args: { remoteBytes: Uint8Array } };

export type RpcReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } };

export type WorkerReadyMessage = {
  type: 'ready';
  storageMode: 'opfs' | 'memory';
  /** Set when `storageMode` is `memory` — surfaced in the main-thread console and UI. */
  storageHint?: string;
};

export type WorkerInboundMessage = RpcRequest | WorkerReadyMessage;
