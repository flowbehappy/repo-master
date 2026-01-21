import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type RepoSnippet = {
  filePath: string;
  matchLine: number;
  excerpt: string;
  score: number;
};

export type RepoSearchResult = {
  query: string;
  snippets: RepoSnippet[];
  contextText: string;
  sources: string[];
};

type RepoIndex = {
  files: string[];
  builtAtMs: number;
  maxFiles: number;
};

const repoIndexCache = new Map<string, RepoIndex>();

function isProbablyBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let suspicious = 0;
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  for (const byte of sample) {
    if (byte === 0) return true;
    // Allow common whitespace and UTF-8 bytes; count other control chars.
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.05;
}

function tokenizeQuery(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const quoted: string[] = [];
  for (const m of trimmed.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const q = (m[1] ?? m[2] ?? "").trim();
    if (q.length >= 3) quoted.push(q);
  }

  const raw = trimmed
    .replace(/[`"'(),.<>[\]{}]/g, " ")
    .replace(/[^\p{L}\p{N}_:./\- ]/gu, " ")
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter(Boolean);

  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "is",
    "are",
    "be",
    "as",
    "at",
    "by",
    "from",
    "it",
    "this",
    "that",
    "these",
    "those",
    "we",
    "i",
    "you",
    "they",
    "he",
    "she",
    "them",
    "our",
    "your",
    "their",
    "not"
  ]);

  const tokens = [...quoted, ...raw]
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stop.has(t.toLowerCase()));

  // De-dupe while preserving order; keep a larger budget for "best effect".
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 48) break;
  }
  return out;
}

function shouldSkipPath(relPath: string): boolean {
  const p = relPath.toLowerCase();
  if (p.startsWith(".git/")) return true;
  if (p.includes("/.git/")) return true;
  if (p.includes("/node_modules/")) return true;
  if (p.includes("/vendor/")) return true;
  if (p.includes("/target/")) return true;
  if (p.includes("/dist/")) return true;
  if (p.includes("/build/")) return true;
  if (p.endsWith(".png") || p.endsWith(".jpg") || p.endsWith(".jpeg") || p.endsWith(".gif") || p.endsWith(".pdf")) return true;
  return false;
}

async function runGitLsFiles(repoPath: string): Promise<string[] | undefined> {
  const gitDir = path.join(repoPath, ".git");
  if (!fs.existsSync(gitDir)) return undefined;

  return new Promise((resolve) => {
    const child = spawn("git", ["-C", repoPath, "ls-files", "-z"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (b) => chunks.push(Buffer.from(b)));
    child.on("close", (code) => {
      if (code !== 0) return resolve(undefined);
      const stdout = Buffer.concat(chunks).toString("utf8");
      const files = stdout
        .split("\0")
        .map((s) => s.trim())
        .filter(Boolean);
      resolve(files);
    });
    child.on("error", () => resolve(undefined));
  });
}

function walkFiles(repoPath: string, maxFiles: number): string[] {
  const out: string[] = [];
  const queue: string[] = [repoPath];

  while (queue.length > 0 && out.length < maxFiles) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(repoPath, abs);
      if (shouldSkipPath(rel)) continue;

      if (entry.isDirectory()) {
        queue.push(abs);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  return out;
}

export async function getRepoIndex(repoPath: string, maxFiles: number): Promise<RepoIndex> {
  const cached = repoIndexCache.get(repoPath);
  if (cached && cached.maxFiles >= maxFiles) {
    return { files: cached.files.slice(0, maxFiles), builtAtMs: cached.builtAtMs, maxFiles: cached.maxFiles };
  }

  const gitFiles = await runGitLsFiles(repoPath);
  const files = (gitFiles ?? walkFiles(repoPath, maxFiles))
    .filter((p) => !shouldSkipPath(p))
    .slice(0, maxFiles);

  const index: RepoIndex = { files, builtAtMs: Date.now(), maxFiles };
  repoIndexCache.set(repoPath, index);
  return index;
}

function makeExcerpt(lines: string[], matchLine: number, contextLines: number): string {
  const total = lines.length;
  const startIdx = Math.max(0, matchLine - 1 - contextLines);
  const endIdx = Math.min(total - 1, matchLine - 1 + contextLines);

  const rendered: string[] = [];
  for (let i = startIdx; i <= endIdx; i += 1) {
    const lineNo = i + 1;
    rendered.push(`${String(lineNo).padStart(5, " ")} | ${lines[i] ?? ""}`);
  }
  return rendered.join("\n");
}

function countMatchesInLine(line: string, tokensLower: string[]): number {
  const lower = line.toLowerCase();
  let hits = 0;
  for (const token of tokensLower) {
    if (lower.includes(token)) hits += 1;
  }
  return hits;
}

function scoreFile(lines: string[], tokensLower: string[]): { score: number; bestLine: number | undefined } {
  let score = 0;
  let bestLine: number | undefined;
  let bestLineScore = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const hits = countMatchesInLine(lines[i] ?? "", tokensLower);
    if (hits > 0) {
      score += hits;
      if (hits > bestLineScore) {
        bestLineScore = hits;
        bestLine = i + 1;
      }
    }
  }

  // Prefer docs slightly if everything else is equal.
  return { score, bestLine };
}

export async function searchRepo(opts: {
  repoPath: string;
  query: string;
  maxFiles: number;
  maxFileBytes: number;
  maxSnippets: number;
  snippetContextLines: number;
  maxContextChars: number;
}): Promise<RepoSearchResult> {
  const query = opts.query.trim();
  const tokens = tokenizeQuery(query);
  if (!query || tokens.length === 0) {
    return { query, snippets: [], contextText: "", sources: [] };
  }

  const tokensLower = tokens.map((t) => t.toLowerCase());
  const index = await getRepoIndex(opts.repoPath, opts.maxFiles);

  const candidates: Array<{ filePath: string; score: number; bestLine: number }> = [];

  for (const relPath of index.files) {
    const absPath = path.join(opts.repoPath, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size <= 0 || stat.size > opts.maxFileBytes) continue;

    let buf: Buffer;
    try {
      buf = fs.readFileSync(absPath);
    } catch {
      continue;
    }
    if (isProbablyBinary(buf)) continue;

    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/g);
    const { score, bestLine } = scoreFile(lines, tokensLower);
    if (!bestLine || score <= 0) continue;

    candidates.push({ filePath: relPath, score, bestLine });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, Math.max(opts.maxSnippets, 1));

  const snippets: RepoSnippet[] = [];
  for (const c of top) {
    const absPath = path.join(opts.repoPath, c.filePath);
    let text: string;
    try {
      text = fs.readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/g);
    const excerpt = makeExcerpt(lines, c.bestLine, opts.snippetContextLines);
    snippets.push({ filePath: c.filePath, matchLine: c.bestLine, excerpt, score: c.score });
  }

  const sources = snippets.map((s) => `${s.filePath}:${s.matchLine}`);

  let contextText = "";
  for (const snippet of snippets) {
    const block = `File: ${snippet.filePath}:${snippet.matchLine}\n${snippet.excerpt}\n`;
    if (contextText.length + block.length > opts.maxContextChars) break;
    contextText += `${contextText ? "\n" : ""}${block}`;
  }

  return { query, snippets, contextText: contextText.trim(), sources };
}
