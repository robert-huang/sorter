/// <reference lib="webworker" />
import { buildReadyMessage, initDbWorker, queueRpc, type WorkerPost } from './dbWorkerCore';
import type { RpcReply, RpcRequest, WorkerReadyMessage } from './rpc';

function postMessage(msg: RpcReply | WorkerReadyMessage): void {
  self.postMessage(msg);
}

const post: WorkerPost = postMessage;

void initDbWorker().then(() => {
  post(buildReadyMessage());
});

self.addEventListener('message', (event: MessageEvent<RpcRequest>) => {
  queueRpc(event.data, post);
});
