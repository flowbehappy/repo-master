import OpenAI from "openai";

import type { AppConfig } from "../config.js";

export type AnswerResult = {
  mode: "llm" | "fallback";
  answer: string;
  sources: string[];
};

export type PromptImage = {
  dataUrl: string;
  detail?: "low" | "high" | "auto";
};

function fallbackAnswer(
  question: string,
  transcript: string,
  repoContext?: string,
  images?: PromptImage[],
  externalContext?: string
): AnswerResult {
  const header = `Fallback mode (no LLM)\n\nQuestion:\n${question.trim()}`;
  const context = transcript.trim() ? `\n\nChat context (may be partial):\n${transcript.trim()}` : "";
  const repo = repoContext?.trim() ? `\n\nRepo context:\n${repoContext.trim()}` : "";
  const external = externalContext?.trim() ? `\n\nExternal context:\n${externalContext.trim()}` : "";
  const imageInfo = images && images.length > 0 ? `\n\nImages: ${images.length} attached (vision unavailable in fallback).` : "";
  return {
    mode: "fallback",
    answer: `${header}${context}${repo}${external}${imageInfo}\n\n(If you need more code context, include file paths/identifiers or paste the relevant snippet.)`,
    sources: []
  };
}

function buildSystemPrompt(botName: string): string {
  const mentionName = botName.trim() || "deephack";
  return [
    "Your name is Repo Master.",
    `In Feishu group chats, users may mention you as @${mentionName}.`,
    "If asked about your name/identity, say you are Repo Master. Do not claim to be Codex/ChatGPT/OpenAI or any other assistant.",
    "You are a TiDB question assistant and repository code assistant.",
    "Answer using the provided chat context, repo context, external knowledge context (if any), images (if any), and the user's question.",
    "Do not browse the web or use external search beyond TiDB.ai (when it is available via the provided external context).",
    "If external knowledge context is present, treat it as evidence (it may be incomplete or incorrect) and rewrite it in your own structure.",
    "Cross-check external knowledge context against repo context when applicable; if they conflict, call out the conflict and prioritize the repo's behavior for this repository.",
    "For TiDB/TiKV/PD/TiCDC/TiDB Cloud product facts: prefer external knowledge context when available. If it is missing (e.g., TiDB.ai failed), still answer with best-effort guidance, but clearly label it as not docs-backed and avoid over-precise claims.",
    "If images are provided, interpret them carefully and extract relevant text/code from them.",
    "If you do not have enough repo context, ask the user to provide file paths or paste relevant code.",
    "Never fabricate citations. Cite repo sources as `path:line` and external sources as URLs when used.",
    "Be concise: prefer short bullet points and direct steps; avoid long background. If essential details are missing, ask 1–3 targeted questions."
  ].join("\n");
}

function buildUserPrompt(opts: {
  question: string;
  transcript: string;
  repoContext?: string;
  externalContext?: string;
  followUpQuestions?: string[];
  availableRepos?: string[];
  repoHints?: string[];
}): string {
  const blocks = [
    "User question:",
    opts.question.trim(),
    "",
    "Chat context (may be partial):",
    opts.transcript.trim() || "(none)"
  ];

  if (opts.availableRepos && opts.availableRepos.length > 0) {
    blocks.push("", "Configured local repos (name@variant: path):", ...opts.availableRepos);
  }

  if (opts.repoHints && opts.repoHints.length > 0) {
    blocks.push("", "Repo hints:", ...opts.repoHints);
  }

  if (opts.repoContext?.trim()) {
    blocks.push("", "Repo context:", opts.repoContext.trim(), "", "When using repo context, cite sources as `path:line`.");
  }

  if (opts.externalContext?.trim()) {
    blocks.push("", "External knowledge context:", opts.externalContext.trim(), "", "When using external context, cite URLs when possible.");
  }

  if (opts.followUpQuestions && opts.followUpQuestions.length > 0) {
    const qs = opts.followUpQuestions.map((q) => q.trim()).filter(Boolean);
    if (qs.length > 0) {
      blocks.push("", "If needed, ask the user for missing info (keep it concise):", ...qs.map((q) => `- ${q}`));
    }
  }

  return blocks.join("\n");
}

function resolveReasoningEffort(config: AppConfig): string | undefined {
  const raw = config.openaiModelReasoningEffort?.trim();
  if (!raw) return undefined;

  const effort = raw.toLowerCase();

  // For the real OpenAI API, only low|medium|high are supported. For custom
  // OpenAI-compatible providers, allow Codex-style values like "xhigh".
  const strictOpenAI = !config.openaiBaseUrl || config.openaiModelProvider.trim().toLowerCase() === "openai";
  if (strictOpenAI) {
    if (effort === "xlow") return "low";
    if (effort === "xhigh") return "high";
  }

  return effort;
}

export async function generateAnswer(opts: {
  config: AppConfig;
  question: string;
  transcript: string;
  repoContext?: string;
  sources?: string[];
  images?: PromptImage[];
  externalContext?: string;
  followUpQuestions?: string[];
}): Promise<AnswerResult> {
  if (opts.config.mode === "fallback" || !opts.config.openaiApiKey) {
    return {
      ...fallbackAnswer(opts.question, opts.transcript, opts.repoContext, opts.images, opts.externalContext),
      sources: opts.sources ?? []
    };
  }

  try {
    const client = new OpenAI({
      apiKey: opts.config.openaiApiKey,
      ...(opts.config.openaiBaseUrl ? { baseURL: opts.config.openaiBaseUrl } : {})
    });

    const systemPrompt = buildSystemPrompt(opts.config.botName);
    const availableRepos = opts.config.repos.map((r) => `- ${r.displayName}: ${r.path}`);
    const repoNameSet = new Set(opts.config.repos.map((r) => r.name.trim().toLowerCase()).filter(Boolean));
    const repoHints: string[] = [];
    if (repoNameSet.has("ticdc")) repoHints.push("- CDC (new architecture, v8.5+): ticdc");
    if (repoNameSet.has("tiflow")) repoHints.push("- CDC (old architecture) + DM: tiflow");
    const userPrompt = buildUserPrompt({ ...opts, availableRepos, repoHints });
    const reasoningEffort = resolveReasoningEffort(opts.config);

    try {
      const body: any = {
        model: opts.config.openaiModel,
        instructions: systemPrompt
      };
      if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
      if (opts.images && opts.images.length > 0) {
        const content: any[] = [{ type: "input_text", text: userPrompt }];
        for (const img of opts.images) {
          content.push({
            type: "input_image",
            image_url: img.dataUrl,
            ...(img.detail ? { detail: img.detail } : {})
          });
        }
        body.input = [{ role: "user", content }];
      } else {
        body.input = userPrompt;
      }

      const resp = await client.responses.create(body);

      const answer = resp.output_text?.trim();
      if (answer) return { mode: "llm", answer, sources: opts.sources ?? [] };
    } catch {
      // Some providers may not implement /responses; fall back to chat completions.
    }

    const userMessage: any =
      opts.images && opts.images.length > 0
        ? {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              ...opts.images.map((img) => ({
                type: "image_url",
                image_url: { url: img.dataUrl, ...(img.detail ? { detail: img.detail } : {}) }
              }))
            ]
          }
        : { role: "user", content: userPrompt };

    const resp = await client.chat.completions.create({
      model: opts.config.openaiModel,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        userMessage
      ]
    });

    const answer = resp.choices[0]?.message?.content?.trim();
    if (!answer) {
      return {
        ...fallbackAnswer(opts.question, opts.transcript, opts.repoContext, opts.images, opts.externalContext),
        sources: opts.sources ?? []
      };
    }

    return { mode: "llm", answer, sources: opts.sources ?? [] };
  } catch {
    return {
      ...fallbackAnswer(opts.question, opts.transcript, opts.repoContext, opts.images, opts.externalContext),
      sources: opts.sources ?? []
    };
  }
}
