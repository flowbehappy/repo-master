import { isMainThread } from "node:worker_threads";

import { logger } from "../logger.js";
import { runRepoSearchInPool } from "./workerPool.js";
import { searchReposLocal, type MultiRepoSearchOptions, type MultiRepoSearchResult } from "./multiSearchLocal.js";

export type { MultiRepoSearchResult } from "./multiSearchLocal.js";

export type MultiRepoSearchOptionsWithWorkers = MultiRepoSearchOptions & {
  workers?: number;
  queueMax?: number;
};

export async function searchRepos(opts: MultiRepoSearchOptionsWithWorkers): Promise<MultiRepoSearchResult> {
  const workers = Math.max(0, Math.floor(opts.workers ?? 0));
  const query = opts.query.trim();
  if (!query || opts.repos.length === 0) return { query, contextText: "", sources: [] };

  const localOpts: MultiRepoSearchOptions = {
    repos: opts.repos,
    query,
    maxFiles: opts.maxFiles,
    maxFileBytes: opts.maxFileBytes,
    maxSnippets: opts.maxSnippets,
    snippetContextLines: opts.snippetContextLines,
    maxContextChars: opts.maxContextChars
  };

  if (!isMainThread || workers <= 0) return searchReposLocal(localOpts);

  try {
    return await runRepoSearchInPool(workers, {
      repos: opts.repos,
      query,
      maxFiles: opts.maxFiles,
      maxFileBytes: opts.maxFileBytes,
      maxSnippets: opts.maxSnippets,
      snippetContextLines: opts.snippetContextLines,
      maxContextChars: opts.maxContextChars,
      queueMax: opts.queueMax
    });
  } catch (error) {
    logger.warn({ err: error }, "Repo search worker pool failed; falling back to in-process scan");
    return searchReposLocal(localOpts);
  }
}
