/// <reference lib="webworker" />
import {
  buildReadyMessage,
  initDbWorker,
  isSqliteReady,
  queueRpc,
  type WorkerPost,
} from './dbWorkerCore';
import type { RpcRequest } from './rpc';

declare const self: SharedWorkerGlobalScope;

const connectedPorts = new Set<MessagePort>();

function postReady(port: MessagePort): void {
  port.postMessage(buildReadyMessage());
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

function broadcastReady(): void {
  const ready = buildReadyMessage();
  for (const port of connectedPorts) {
    port.postMessage(ready);
  }
}

void initDbWorker().then(() => {
  broadcastReady();
});

self.onconnect = (event: MessageEvent): void => {
  const port = event.ports[0];
  if (!port) {
    return;
  }
  attachPort(port);
};
