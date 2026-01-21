import OpenAI from "openai";

import type { AppConfig } from "../config.js";

export type CodeQuestionAnalysis = {
  isCodeRelated: boolean;
  needsRepoLookup: boolean;
  searchQuery: string;
};

export type PromptImage = {
  dataUrl: string;
  detail?: "low" | "high" | "auto";
};

function heuristicIsCodeRelated(question: string): boolean {
  const q = question.toLowerCase();
  if (/\b(panic|stack trace|segfault|nil pointer|null pointer)\b/.test(q)) return true;
  if (/\b(error|exception|bug|issue|problem|crash|fails|failing|build|regression|fix)\b/.test(q)) return true;
  if (/\b(function|method|class|struct|interface|package|module)\b/.test(q)) return true;
  if (/\b(golang|go|rust|java|node|typescript|python)\b/.test(q)) return true;
  if (/\b(go\.mod|package\.json|makefile)\b/.test(q)) return true;
  if (/\.(go|rs|js|ts|py|java|proto|yaml|yml|toml)\b/.test(q)) return true;
  if (/[A-Za-z_]\w*\(/.test(question)) return true;
  return false;
}

function heuristicNeedsRepoLookup(question: string): boolean {
  const q = question.toLowerCase();
  if (/\b(where|which file|what file|location|implemented|implementation|how does .* work)\b/.test(q)) return true;
  if (/\b(in this repo|in the repo|in the codebase|source code)\b/.test(q)) return true;
  if (/\b(in\s+(?:ticdc|tidb|tikv|tiflash|pd)\b|(?:ticdc|tidb|tikv|tiflash|pd)\s+repo\b)/.test(q)) return true;

  const mentionsComponent = /\b(ticdc|cdc|tidb|tikv|tiflash|pd)\b/.test(q);
  const mentionsBug = /\b(error|panic|stack trace|fails|failing|bug|issue|problem|regression)\b/.test(q);
  if (mentionsComponent && mentionsBug) return true;

  if (/\b(error|panic|stack trace|fails|failing)\b/.test(q)) return true;
  return false;
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

export async function analyzeCodeQuestion(opts: {
  config: AppConfig;
  question: string;
  transcript: string;
  images?: PromptImage[];
}): Promise<CodeQuestionAnalysis> {
  const question = opts.question.trim();
  const hasRepo = opts.config.repos.length > 0;

  const fallback: CodeQuestionAnalysis = {
    isCodeRelated: heuristicIsCodeRelated(question),
    needsRepoLookup: hasRepo && heuristicNeedsRepoLookup(question),
    searchQuery: question
  };

  if (opts.config.mode !== "llm" || !opts.config.openaiApiKey) return fallback;

  try {
    const client = new OpenAI({
      apiKey: opts.config.openaiApiKey,
      ...(opts.config.openaiBaseUrl ? { baseURL: opts.config.openaiBaseUrl } : {})
    });

    const system = [
      "You are a classifier for a coding assistant bot.",
      "Return ONLY valid JSON with keys:",
      "- is_code_related: boolean",
      "- needs_repo_lookup: boolean (true only if checking local repo code/docs is necessary)",
      "- search_query: string (keywords to search in the repo if needs_repo_lookup=true)",
      "",
      "Guidelines:",
      "- If images are provided, use them (OCR/understanding) to classify and extract a useful search_query.",
      "- If the question is general programming advice with no repo-specific details, needs_repo_lookup=false.",
      "- If it asks about how this specific project behaves/implements something, needs_repo_lookup=true.",
      "- If repo lookup is impossible (repo not configured), set needs_repo_lookup=false.",
      "",
      `Repo configured: ${hasRepo ? "yes" : "no"}`,
      "Available repos:",
      ...(hasRepo ? opts.config.repos.map((r) => `- ${r.displayName}`) : ["(none)"])
    ].join("\n");

    const user = [
      "Question:",
      question,
      "",
      "Chat context (may be partial):",
      opts.transcript.trim() || "(none)"
    ].join("\n");

    const callResponses = async (): Promise<string | undefined> => {
      const body: any = { model: opts.config.openaiModel, instructions: system };
      if (opts.images && opts.images.length > 0) {
        const content: any[] = [{ type: "input_text", text: user }];
        for (const img of opts.images) {
          content.push({
            type: "input_image",
            image_url: img.dataUrl,
            ...(img.detail ? { detail: img.detail } : {})
          });
        }
        body.input = [{ role: "user", content }];
      } else {
        body.input = user;
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
                { type: "text", text: user },
                ...opts.images.map((img) => ({
                  type: "image_url",
                  image_url: { url: img.dataUrl, ...(img.detail ? { detail: img.detail } : {}) }
                }))
              ]
            }
          : { role: "user", content: user };

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
      is_code_related?: boolean;
      needs_repo_lookup?: boolean;
      search_query?: string;
    };

    const isCodeRelated = typeof parsed.is_code_related === "boolean" ? parsed.is_code_related : fallback.isCodeRelated;
    const needsRepoLookupRaw =
      typeof parsed.needs_repo_lookup === "boolean" ? parsed.needs_repo_lookup : fallback.needsRepoLookup;
    // Keep heuristics as a safety net so we don't miss obvious repo-related questions.
    const needsRepoLookup = hasRepo ? (needsRepoLookupRaw || fallback.needsRepoLookup) : false;
    const searchQuery = (typeof parsed.search_query === "string" && parsed.search_query.trim()) ? parsed.search_query.trim() : question;

    return { isCodeRelated, needsRepoLookup, searchQuery };
  } catch {
    return fallback;
  }
}
