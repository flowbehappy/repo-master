import OpenAI from "openai";

import type { AppConfig } from "../config.js";
import type { PromptImage } from "./codeQuestion.js";

export type HistoryNeedAnalysis = {
  needsHistory: boolean;
};

function heuristicNeedsHistory(opts: { question: string; hasImages: boolean }): boolean {
  const q = opts.question.trim();
  if (!q) return false;

  const lower = q.toLowerCase();

  const looksLikeAck =
    /^(ok|okay|thanks|thank you|got it|roger|received|nice|cool|great|👍|👌|好的|收到|谢谢|多谢)\b/i.test(q);
  if (looksLikeAck) return false;

  const hasConcreteDetails =
    /```/.test(q) ||
    /\b(panic|stack trace|traceback|exception)\b/.test(lower) ||
    /\b(error|failed|fails|failing|crash)\b/.test(lower) ||
    /\b(go\.mod|package\.json|makefile|dockerfile)\b/.test(lower) ||
    /\b[\w./-]+\.(go|rs|ts|js|py|java|proto|yaml|yml|toml|json|md)\b/i.test(q) ||
    /[A-Za-z_]\w*\(/.test(q);
  if (hasConcreteDetails) return false;

  const referential =
    /\b(above|below|earlier|previous|prior|same as|as before|as we discussed|like before|continue|still|again)\b/.test(lower) ||
    /\b(more|more details|elaborate|expand|follow up)\b/.test(lower) ||
    /\b(this|that|it|they|these|those)\b/.test(lower);

  // If images are attached to this message, we can usually answer without fetching
  // more history unless the user explicitly references previous context.
  if (opts.hasImages) {
    return /\b(above|earlier|previous|prior|same as|as before|compare|difference)\b/.test(lower);
  }

  if (referential) return true;

  const wordCount = q.split(/\s+/g).filter(Boolean).length;
  const extremelyShort = q.length < 12 || wordCount <= 2;
  if (extremelyShort) return true;

  return false;
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

export async function analyzeHistoryNeed(opts: {
  config: AppConfig;
  question: string;
  hasImages: boolean;
  images?: PromptImage[];
}): Promise<HistoryNeedAnalysis> {
  const fallback: HistoryNeedAnalysis = { needsHistory: heuristicNeedsHistory({ question: opts.question, hasImages: opts.hasImages }) };

  if (opts.config.mode !== "llm" || !opts.config.openaiApiKey) return fallback;

  try {
    const client = new OpenAI({
      apiKey: opts.config.openaiApiKey,
      ...(opts.config.openaiBaseUrl ? { baseURL: opts.config.openaiBaseUrl } : {})
    });

    const system = [
      "You decide whether the bot must fetch more chat history BEFORE answering.",
      "Return ONLY valid JSON with keys:",
      "- needs_history: boolean",
      "",
      "Guidelines:",
      "- If the user's latest message is self-contained, needs_history=false.",
      "- If it references prior context (e.g. 'as above', 'that', 'same as before'), needs_history=true.",
      "- If images are attached to the current message, you can often answer without history unless the user requests comparison with previous messages.",
      "- Do not include extra keys or markdown."
    ].join("\n");

    const userText = [
      "Latest user message:",
      opts.question.trim(),
      "",
      `Current message has images: ${opts.hasImages ? "yes" : "no"}`
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

    const parsed = JSON.parse(jsonText) as { needs_history?: boolean };
    if (typeof parsed.needs_history !== "boolean") return fallback;

    return { needsHistory: parsed.needs_history };
  } catch {
    return fallback;
  }
}
