/// <reference lib="webworker" />
import {
  failAllPending,
  getStorageMode,
  initDbWorker,
  isSqliteReady,
  queueRpc,
  type WorkerPost,
} from './dbWorkerCore';
import type { RpcRequest, WorkerReadyMessage } from './rpc';

declare const self: SharedWorkerGlobalScope;

const connectedPorts = new Set<MessagePort>();

function postReady(port: MessagePort): void {
  const msg: WorkerReadyMessage = { type: 'ready', storageMode: getStorageMode() };
  port.postMessage(msg);
}

function attachPort(port: MessagePort): void {
  port.start();
  connectedPorts.add(port);

  if (isSqliteReady()) {
    postReady(port);
  }

  const post: WorkerPost = (msg) => {
    port.postMessage(msg);
  };

  port.addEventListener('message', (event: MessageEvent<RpcRequest>) => {
    queueRpc(event.data, post);
  });

  port.addEventListener('messageerror', () => {
    connectedPorts.delete(port);
  });
}

void initDbWorker()
  .then((storageMode) => {
    for (const port of connectedPorts) {
      port.postMessage({ type: 'ready', storageMode });
    }
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'SQLite worker init failed';
    failAllPending(message);
  });

self.onconnect = (event: MessageEvent): void => {
  const port = event.ports[0];
  if (!port) {
    return;
  }
  attachPort(port);
};
