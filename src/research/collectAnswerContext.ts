import type { AppConfig } from "../config.js";
import { analyzeCodeQuestion, type PromptImage } from "../analysis/codeQuestion.js";
import { selectReposForSearch } from "../analysis/repoSelect.js";
import { analyzeResearchFollowups } from "../analysis/researchFollowup.js";
import { searchRepos } from "../repo/multiSearch.js";
import { queryTidbAi, shouldQueryTidbAi } from "../tidbAi.js";

export type CollectedAnswerContext = {
  repoContext?: string;
  externalContext?: string;
  sources: string[];
  followUpQuestions: string[];
  warnings: string[];
};

type RepoBlock = { query: string; contextText: string; sources: string[] };
type TidbBlock = { query: string; contextText: string; sources: string[] };

function normalizeQuery(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

function mergeSources(lists: Array<string[] | undefined>, max: number): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const v = (item ?? "").trim();
      if (!v) continue;
      if (out.includes(v)) continue;
      out.push(v);
      if (out.length >= Math.max(1, max)) return out;
    }
  }
  return out;
}

function joinBlocks(blocks: Array<{ query: string; contextText: string }>, maxChars: number): string | undefined {
  const parts: string[] = [];
  for (const b of blocks) {
    const header = b.query ? `Query: ${b.query}\n` : "";
    const body = (b.contextText ?? "").trim();
    if (!body) continue;
    parts.push(`${header}${body}`.trim());
  }

  const merged = parts.join("\n\n---\n\n").trim();
  if (!merged) return undefined;
  if (merged.length <= maxChars) return merged;
  return `${merged.slice(0, Math.max(0, maxChars - 20))}\n\n…(truncated)`;
}

export async function collectAnswerContext(opts: {
  config: AppConfig;
  question: string;
  transcript: string;
  images: PromptImage[];
}): Promise<CollectedAnswerContext> {
  const maxResearchRounds = 3;

  const repoBlocks: RepoBlock[] = [];
  const tidbBlocks: TidbBlock[] = [];
  const followUpQuestions: string[] = [];

  const seenRepoQueries = new Set<string>();
  const seenTidbQueries = new Set<string>();

  const tidbFailures: string[] = [];

  const addRepo = (query: string, contextText: string, sources: string[]) => {
    const body = (contextText ?? "").trim();
    if (!body) return;
    repoBlocks.push({ query, contextText: body, sources });
  };

  const addTidb = (query: string, contextText: string, sources: string[]) => {
    const body = (contextText ?? "").trim();
    if (!body) return;
    tidbBlocks.push({ query, contextText: body, sources });
  };

  const analysis = await analyzeCodeQuestion({
    config: opts.config,
    question: opts.question,
    transcript: opts.transcript,
    images: opts.images
  });

  const canRepo = opts.config.repos.length > 0;
  let canTidb = shouldQueryTidbAi({ config: opts.config, question: opts.question, transcript: opts.transcript });

  const initialRepoQuery = analysis.needsRepoLookup && canRepo ? normalizeQuery(analysis.searchQuery) : undefined;
  const initialTidbQuery = canTidb ? normalizeQuery(opts.question) : undefined;

  if (initialRepoQuery) seenRepoQueries.add(initialRepoQuery);
  if (initialTidbQuery) seenTidbQueries.add(initialTidbQuery);

  const reposForInitialQuery = canRepo
    ? selectReposForSearch({ config: opts.config, question: opts.question, transcript: opts.transcript })
    : [];

  const initialRepoPromise = initialRepoQuery
    ? searchRepos({
      repos: reposForInitialQuery,
      query: initialRepoQuery,
      maxFiles: opts.config.repoMaxFiles,
      maxFileBytes: opts.config.repoMaxFileBytes,
      maxSnippets: opts.config.repoMaxSnippets,
      snippetContextLines: opts.config.repoSnippetContextLines,
      maxContextChars: opts.config.repoMaxContextChars,
      workers: opts.config.repoSearchWorkers,
      queueMax: opts.config.repoSearchQueueMax
    })
    : Promise.resolve(undefined);

  const initialTidbPromise = initialTidbQuery
    ? queryTidbAi({
        baseUrl: opts.config.tidbAiBaseUrl,
        chatEngine: opts.config.tidbAiChatEngine,
        question: initialTidbQuery,
        transcript: opts.transcript,
        timeoutMs: opts.config.tidbAiTimeoutMs,
        maxContextChars: opts.config.tidbAiMaxContextChars,
        maxSources: opts.config.tidbAiMaxSources
      })
    : Promise.resolve(undefined);

  const [initialRepo, initialTidb] = await Promise.all([initialRepoPromise, initialTidbPromise]);

  if (initialRepo && initialRepo.contextText.trim()) addRepo(initialRepoQuery ?? opts.question, initialRepo.contextText, initialRepo.sources);
  if (initialTidb && initialTidb.ok && initialTidb.result.contextText.trim()) {
    addTidb(initialTidbQuery ?? opts.question, initialTidb.result.contextText, initialTidb.result.sources);
  } else if (initialTidb && !initialTidb.ok) {
    tidbFailures.push(initialTidb.error);
    if (initialTidb.kind !== "empty") canTidb = false;
  }

  for (let round = 2; round <= maxResearchRounds; round += 1) {
    if (opts.config.mode !== "llm" || !opts.config.openaiApiKey) break;

    const repoContextSoFar = joinBlocks(repoBlocks, opts.config.repoMaxContextChars);
    const externalContextSoFar = joinBlocks(tidbBlocks, opts.config.tidbAiMaxContextChars);

    const plan = await analyzeResearchFollowups({
      config: opts.config,
      question: opts.question,
      transcript: opts.transcript,
      repoContext: repoContextSoFar,
      externalContext: externalContextSoFar,
      images: opts.images,
      remainingRounds: maxResearchRounds - round + 1
    });

    if (plan.askUser.length > 0) {
      for (const q of plan.askUser) {
        const v = q.trim();
        if (!v) continue;
        if (followUpQuestions.includes(v)) continue;
        followUpQuestions.push(v);
        if (followUpQuestions.length >= 3) break;
      }
      break;
    }

    const nextRepoQueries = canRepo
      ? plan.repoQueries
          .map((q) => q.trim())
          .filter(Boolean)
          .filter((q) => !seenRepoQueries.has(q))
          .slice(0, 2)
      : [];
    const nextTidbQueries = canTidb
      ? plan.tidbAiQueries
          .map((q) => q.trim())
          .filter(Boolean)
          .filter((q) => !seenTidbQueries.has(q))
          .slice(0, 2)
      : [];

    if (nextRepoQueries.length === 0 && nextTidbQueries.length === 0) break;

    for (const q of nextRepoQueries) seenRepoQueries.add(q);
    for (const q of nextTidbQueries) seenTidbQueries.add(q);

    const repoPromises = nextRepoQueries.map(async (q) => {
      const reposForQuery = canRepo
        ? selectReposForSearch({ config: opts.config, question: `${opts.question}\n${q}`, transcript: opts.transcript })
        : [];
      const res = await searchRepos({
        repos: reposForQuery,
        query: q,
        maxFiles: opts.config.repoMaxFiles,
        maxFileBytes: opts.config.repoMaxFileBytes,
        maxSnippets: opts.config.repoMaxSnippets,
        snippetContextLines: opts.config.repoSnippetContextLines,
        maxContextChars: opts.config.repoMaxContextChars,
        workers: opts.config.repoSearchWorkers,
        queueMax: opts.config.repoSearchQueueMax
      });
      return { q, res };
    });

    const tidbPromises = nextTidbQueries.map(async (q) => {
      const res = await queryTidbAi({
        baseUrl: opts.config.tidbAiBaseUrl,
        chatEngine: opts.config.tidbAiChatEngine,
        question: q,
        transcript: opts.transcript,
        timeoutMs: opts.config.tidbAiTimeoutMs,
        maxContextChars: opts.config.tidbAiMaxContextChars,
        maxSources: opts.config.tidbAiMaxSources
      });
      return { q, res };
    });

    const [repoResults, tidbResults] = await Promise.all([Promise.all(repoPromises), Promise.all(tidbPromises)]);
    for (const item of repoResults) {
      if (item.res.contextText.trim()) addRepo(item.q, item.res.contextText, item.res.sources);
    }
    for (const item of tidbResults) {
      if (item.res?.ok && item.res.result.contextText.trim()) {
        addTidb(item.q, item.res.result.contextText, item.res.result.sources ?? []);
      } else if (item.res && !item.res.ok) {
        tidbFailures.push(item.res.error);
        if (item.res.kind !== "empty") canTidb = false;
      }
    }

    if (plan.done) break;
  }

  const repoContext = joinBlocks(repoBlocks, opts.config.repoMaxContextChars);

  const externalContext = joinBlocks(tidbBlocks, opts.config.tidbAiMaxContextChars);

  const sources = mergeSources(
    [repoBlocks.flatMap((b) => b.sources), tidbBlocks.flatMap((b) => b.sources)],
    20
  );

  const warnings: string[] = [];
  if (initialTidbQuery && !externalContext) {
    const msg = tidbFailures.find((x) => x.trim()) ?? "tidb.ai returned no usable content";
    warnings.push(`TiDB.ai is unavailable for this question (${msg}). Answering without TiDB.ai context.`);
  }

  return { repoContext, externalContext, sources, followUpQuestions, warnings };
}
