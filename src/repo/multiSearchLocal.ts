import path from "node:path";

import type { RepoTarget } from "../config.js";
import { searchRepo, type RepoSnippet } from "./search.js";

export type MultiRepoSearchResult = {
  query: string;
  contextText: string;
  sources: string[];
};

export type MultiRepoSearchOptions = {
  repos: RepoTarget[];
  query: string;
  maxFiles: number;
  maxFileBytes: number;
  maxSnippets: number;
  snippetContextLines: number;
  maxContextChars: number;
};

type RepoWithName = {
  repoPath: string;
  repoLabel: string;
};

function normalizeRepos(repos: RepoTarget[]): RepoWithName[] {
  const out: RepoWithName[] = [];
  const seen = new Set<string>();

  for (const repo of repos) {
    const abs = path.resolve((repo.path ?? "").trim());
    if (!abs) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);

    const fallbackName = path.basename(abs) || abs;
    const label = (repo.displayName ?? repo.name ?? "").trim() || fallbackName;
    out.push({ repoPath: abs, repoLabel: label });
  }
  return out;
}

function snippetSource(repoPath: string, snippet: RepoSnippet): string {
  return `${path.join(repoPath, snippet.filePath)}:${snippet.matchLine}`;
}

export async function searchReposLocal(opts: MultiRepoSearchOptions): Promise<MultiRepoSearchResult> {
  const query = opts.query.trim();
  const repos = normalizeRepos(opts.repos);
  if (!query || repos.length === 0) return { query, contextText: "", sources: [] };

  const perRepoMaxSnippets = Math.max(opts.maxSnippets, 1);

  const results = await Promise.all(
    repos.map(async (r) => {
      const res = await searchRepo({
        repoPath: r.repoPath,
        query,
        maxFiles: opts.maxFiles,
        maxFileBytes: opts.maxFileBytes,
        maxSnippets: perRepoMaxSnippets,
        snippetContextLines: opts.snippetContextLines,
        maxContextChars: opts.maxContextChars
      });
      return { repo: r, snippets: res.snippets };
    })
  );

  const all: Array<{ repo: RepoWithName; snippet: RepoSnippet }> = [];
  for (const r of results) {
    for (const s of r.snippets) all.push({ repo: r.repo, snippet: s });
  }

  all.sort((a, b) => b.snippet.score - a.snippet.score);
  const selected = all.slice(0, Math.max(opts.maxSnippets, 1));

  const sources: string[] = [];
  const seenSources = new Set<string>();
  for (const { repo, snippet } of selected) {
    const src = snippetSource(repo.repoPath, snippet);
    if (seenSources.has(src)) continue;
    seenSources.add(src);
    sources.push(src);
  }

  let contextText = "";
  for (const { repo, snippet } of selected) {
    const src = snippetSource(repo.repoPath, snippet);
    const block = `Repo: ${repo.repoLabel}\nFile: ${src}\n${snippet.excerpt}\n`;
    if (contextText.length + block.length > opts.maxContextChars) break;
    contextText += `${contextText ? "\n" : ""}${block}`;
  }

  return { query, contextText: contextText.trim(), sources };
}
