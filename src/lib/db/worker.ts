/// <reference lib="webworker" />
import {
  failAllPending,
  initDbWorker,
  queueRpc,
  type WorkerPost,
} from './dbWorkerCore';
import type { RpcReply, RpcRequest, WorkerReadyMessage } from './rpc';

function postMessage(msg: RpcReply | WorkerReadyMessage): void {
  self.postMessage(msg);
}

const post: WorkerPost = postMessage;

void initDbWorker()
  .then((storageMode) => {
    post({ type: 'ready', storageMode });
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'SQLite worker init failed';
    failAllPending(message);
  });

self.addEventListener('message', (event: MessageEvent<RpcRequest>) => {
  queueRpc(event.data, post);
});
