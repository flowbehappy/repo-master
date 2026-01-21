import path from "node:path";

import { searchRepo, type RepoSnippet } from "./search.js";

export type MultiRepoSearchResult = {
  query: string;
  contextText: string;
  sources: string[];
};

type RepoWithName = {
  repoPath: string;
  repoName: string;
};

function uniqueRepoPaths(repoPaths: string[]): RepoWithName[] {
  const out: RepoWithName[] = [];
  const seen = new Set<string>();
  for (const p of repoPaths) {
    const abs = path.resolve(p.trim());
    if (!abs) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ repoPath: abs, repoName: path.basename(abs) || abs });
  }
  return out;
}

function snippetSource(repoPath: string, snippet: RepoSnippet): string {
  return `${path.join(repoPath, snippet.filePath)}:${snippet.matchLine}`;
}

export async function searchRepos(opts: {
  repoPaths: string[];
  query: string;
  maxFiles: number;
  maxFileBytes: number;
  maxSnippets: number;
  snippetContextLines: number;
  maxContextChars: number;
}): Promise<MultiRepoSearchResult> {
  const query = opts.query.trim();
  const repos = uniqueRepoPaths(opts.repoPaths);
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
    const block = `Repo: ${repo.repoName}\nFile: ${src}\n${snippet.excerpt}\n`;
    if (contextText.length + block.length > opts.maxContextChars) break;
    contextText += `${contextText ? "\n" : ""}${block}`;
  }

  return { query, contextText: contextText.trim(), sources };
}

