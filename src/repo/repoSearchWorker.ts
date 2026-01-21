import { parentPort } from "node:worker_threads";

import { searchReposLocal, type MultiRepoSearchOptions } from "./multiSearchLocal.js";

type WorkerRequest = { id: number; payload: MultiRepoSearchOptions };
type WorkerResponse = { id: number; result?: unknown; error?: string };

if (!parentPort) {
  throw new Error("repoSearchWorker started without parentPort");
}

parentPort.on("message", async (msg: WorkerRequest) => {
  const id = msg?.id;
  try {
    const res = await searchReposLocal(msg.payload);
    const out: WorkerResponse = { id, result: res };
    parentPort!.postMessage(out);
  } catch (error) {
    const out: WorkerResponse = { id, error: error instanceof Error ? error.message : String(error) };
    parentPort!.postMessage(out);
  }
});

