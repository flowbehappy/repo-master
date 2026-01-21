import OpenAI from "openai";

import type { AppConfig } from "../config.js";

export type ResearchFollowupPlan = {
  done: boolean;
  repoQueries: string[];
  tidbAiQueries: string[];
  askUser: string[];
};

type PromptImage = { dataUrl: string; detail?: "low" | "high" | "auto" };

function clip(text: string | undefined, maxChars: number): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 20))}\n\n…(truncated)`;
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

function normalizeList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!v) continue;
    if (out.includes(v)) continue;
    out.push(v);
    if (out.length >= Math.max(0, max)) break;
  }
  return out;
}

export async function analyzeResearchFollowups(opts: {
  config: AppConfig;
  question: string;
  transcript: string;
  repoContext?: string;
  externalContext?: string;
  images?: PromptImage[];
  remainingRounds: number;
}): Promise<ResearchFollowupPlan> {
  const fallback: ResearchFollowupPlan = { done: true, repoQueries: [], tidbAiQueries: [], askUser: [] };

  if (opts.config.mode !== "llm" || !opts.config.openaiApiKey) return fallback;

  const hasRepo = opts.config.repoPaths.length > 0;
  const hasTidbAi = opts.config.tidbAiEnabled;

  try {
    const client = new OpenAI({
      apiKey: opts.config.openaiApiKey,
      ...(opts.config.openaiBaseUrl ? { baseURL: opts.config.openaiBaseUrl } : {})
    });

    const system = [
      "You plan follow-up research steps for a TiDB question assistant and repo-code assistant.",
      "Your goal: decide whether more TiDB.ai lookups and/or repo searches are needed BEFORE answering.",
      "Return ONLY valid JSON with keys:",
      "- done: boolean",
      "- repo_queries: string[] (keywords to search local repos; only if needed)",
      "- tidb_ai_queries: string[] (questions to ask TiDB.ai; only if needed)",
      "- ask_user: string[] (targeted missing-info questions; 1-3 items max)",
      "",
      "Constraints:",
      "- Max 2 repo_queries and 2 tidb_ai_queries.",
      "- Keep each query concise (<= 120 chars).",
      "- If you already have enough info to answer concisely, set done=true and keep arrays empty.",
      "- If essential details are missing (e.g., TiDB/TiCDC version, exact error, deployment), prefer ask_user over more searches.",
      "- Only propose repo_queries if repo lookup is possible.",
      "- Only propose tidb_ai_queries if TiDB.ai is enabled.",
      "",
      `Repo lookup possible: ${hasRepo ? "yes" : "no"}`,
      `TiDB.ai enabled: ${hasTidbAi ? "yes" : "no"}`,
      `Remaining research rounds after this: ${Math.max(0, opts.remainingRounds - 1)}`
    ].join("\n");

    const userText = [
      "User question:",
      opts.question.trim(),
      "",
      "Chat context (may be partial):",
      clip(opts.transcript, 4000) || "(none)",
      "",
      "Repo context collected so far:",
      clip(opts.repoContext, 4000) || "(none)",
      "",
      "External knowledge context collected so far:",
      clip(opts.externalContext, 4000) || "(none)"
    ].join("\n");

    const callResponses = async (): Promise<string | undefined> => {
      const body: any = { model: opts.config.openaiModel, instructions: system };
      if (opts.images && opts.images.length > 0) {
        const content: any[] = [{ type: "input_text", text: userText }];
        for (const img of opts.images) {
          content.push({
            type: "input_image",
            image_url: img.dataUrl,
            ...(img.detail ? { detail: img.detail } : {})
          });
        }
        body.input = [{ role: "user", content }];
      } else {
        body.input = userText;
      }
      const resp = await client.responses.create(body);
      return resp.output_text ?? undefined;
    };

    const callChat = async (): Promise<string | undefined> => {
      const userMessage: any =
        opts.images && opts.images.length > 0
          ? {
              role: "user",
              content: [
                { type: "text", text: userText },
                ...opts.images.map((img) => ({
                  type: "image_url",
                  image_url: { url: img.dataUrl, ...(img.detail ? { detail: img.detail } : {}) }
                }))
              ]
            }
          : { role: "user", content: userText };

      const resp = await client.chat.completions.create({
        model: opts.config.openaiModel,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          userMessage
        ]
      });

      const content = resp.choices[0]?.message?.content;
      return typeof content === "string" ? content : undefined;
    };

    let outText: string | undefined;
    try {
      outText = await callResponses();
    } catch {
      outText = await callChat();
    }

    const jsonText = extractJsonObject(outText ?? "");
    if (!jsonText) return fallback;

    const parsed = JSON.parse(jsonText) as {
      done?: boolean;
      repo_queries?: unknown;
      tidb_ai_queries?: unknown;
      ask_user?: unknown;
    };

    const done = typeof parsed.done === "boolean" ? parsed.done : fallback.done;
    const repoQueries = hasRepo ? normalizeList(parsed.repo_queries, 2).map((q) => q.slice(0, 120)) : [];
    const tidbAiQueries = hasTidbAi ? normalizeList(parsed.tidb_ai_queries, 2).map((q) => q.slice(0, 120)) : [];
    const askUser = normalizeList(parsed.ask_user, 3).map((q) => q.slice(0, 200));

    return { done, repoQueries, tidbAiQueries, askUser };
  } catch {
    return fallback;
  }
}

