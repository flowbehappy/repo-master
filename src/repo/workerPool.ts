import { Worker } from "node:worker_threads";

import { logger } from "../logger.js";
import type { MultiRepoSearchOptions, MultiRepoSearchResult } from "./multiSearchLocal.js";

type WorkerRequest = { id: number; payload: MultiRepoSearchOptions };
type WorkerResponse = { id: number; result?: unknown; error?: string };

type Pending = {
  resolve: (value: MultiRepoSearchResult) => void;
  reject: (error: Error) => void;
};

type Task = {
  id: number;
  payload: MultiRepoSearchOptions;
  pending: Pending;
};

type WorkerSlot = {
  worker: Worker;
  busy: boolean;
  taskId?: number;
};

const workerExt = import.meta.url.endsWith(".ts") ? "ts" : "js";
const repoSearchWorkerUrl = new URL(`./repoSearchWorker.${workerExt}`, import.meta.url);

class RepoSearchWorkerPool {
  readonly size: number;
  readonly queueMax: number;

  private readonly workers: WorkerSlot[] = [];
  private readonly queue: Task[] = [];
  private readonly pending = new Map<number, Pending>();

  private nextId = 1;
  private closed = false;

  constructor(size: number, queueMax: number) {
    this.size = Math.max(1, Math.floor(size));
    this.queueMax = Math.max(0, Math.floor(queueMax));

    for (let i = 0; i < this.size; i += 1) this.spawnWorker(i);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    const err = new Error("Repo search worker pool closed");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.queue.length = 0;

    for (const w of this.workers) {
      try {
        void w.worker.terminate();
      } catch {
        // ignore
      }
    }
  }

  run(payload: MultiRepoSearchOptions): Promise<MultiRepoSearchResult> {
    if (this.closed) return Promise.reject(new Error("Repo search worker pool is closed"));

    const id = this.nextId;
    this.nextId = this.nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;

    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      const task: Task = { id, payload, pending };

      const slot = this.workers.find((w) => !w.busy);
      if (slot) {
        this.assign(slot, task);
        return;
      }

      if (this.queueMax === 0) {
        logger.warn({ queueMax: this.queueMax }, "Repo search workers are busy; skipping repo lookup (queue disabled)");
        resolve({ query: payload.query.trim(), contextText: "", sources: [] });
        return;
      }

      if (this.queue.length >= this.queueMax) {
        logger.warn({ queueMax: this.queueMax }, "Repo search queue is full; skipping repo lookup");
        resolve({ query: payload.query.trim(), contextText: "", sources: [] });
        return;
      }

      this.queue.push(task);
    });
  }

  private spawnWorker(index: number): void {
    const worker = new Worker(repoSearchWorkerUrl);
    // Avoid preventing short-lived scripts from exiting after completing a scan.
    worker.unref();
    const slot: WorkerSlot = { worker, busy: false };
    this.workers[index] = slot;

    worker.on("message", (msg: WorkerResponse) => this.handleMessage(index, msg));
    worker.on("error", (error) => this.handleFailure(index, error));
    worker.on("exit", (code) => {
      if (this.closed) return;
      if (code !== 0) this.handleFailure(index, new Error(`Worker exited with code ${code}`));
    });
  }

  private handleMessage(index: number, msg: WorkerResponse): void {
    const slot = this.workers[index];
    const id = typeof msg?.id === "number" ? msg.id : undefined;

    if (slot) {
      slot.busy = false;
      slot.taskId = undefined;
    }

    if (typeof id === "number") {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (typeof msg.error === "string" && msg.error) {
          p.reject(new Error(msg.error));
        } else {
          p.resolve(msg.result as MultiRepoSearchResult);
        }
      }
    }

    this.dispatch();
  }

  private handleFailure(index: number, error: unknown): void {
    const slot = this.workers[index];
    if (!slot) return;

    logger.warn({ error }, "Repo search worker failed; respawning");

    const taskId = slot.taskId;
    slot.busy = false;
    slot.taskId = undefined;

    try {
      void slot.worker.terminate();
    } catch {
      // ignore
    }

    if (typeof taskId === "number") {
      const p = this.pending.get(taskId);
      if (p) {
        this.pending.delete(taskId);
        p.reject(new Error("Repo search worker failed"));
      }
    }

    if (!this.closed) this.spawnWorker(index);
    this.dispatch();
  }

  private assign(slot: WorkerSlot, task: Task): void {
    slot.busy = true;
    slot.taskId = task.id;
    this.pending.set(task.id, task.pending);

    const msg: WorkerRequest = { id: task.id, payload: task.payload };
    slot.worker.postMessage(msg);
  }

  private dispatch(): void {
    if (this.closed) return;
    if (this.queue.length === 0) return;

    for (const slot of this.workers) {
      if (this.queue.length === 0) break;
      if (slot.busy) continue;
      const task = this.queue.shift();
      if (!task) break;
      this.assign(slot, task);
    }
  }
}

let pool: RepoSearchWorkerPool | undefined;

export async function runRepoSearchInPool(
  workers: number,
  opts: MultiRepoSearchOptions & { queueMax?: number }
): Promise<MultiRepoSearchResult> {
  const size = Math.max(1, Math.floor(workers));
  const queueMax = Math.max(0, Math.floor(opts.queueMax ?? 0));

  if (!pool || pool.size !== size || pool.queueMax !== queueMax) {
    pool?.close();
    pool = new RepoSearchWorkerPool(size, queueMax);
  }

  return pool.run(opts);
}
