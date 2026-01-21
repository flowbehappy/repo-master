import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";

export type TidbAiResult = {
  answer: string;
  contextText: string;
  sources: string[];
  trace?: string;
};

type TidbAiSource = {
  source_uri?: string;
  name?: string;
};

type TidbAiChatResponse = {
  content?: string;
  sources?: TidbAiSource[];
  trace?: string;
};

let tidbAiBidCookie: string | undefined;

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 20))}\n\n…(truncated)`;
}

function sanitizeForTidbAi(text: string, maxChars: number): string {
  const raw = text ?? "";
  if (!raw.trim()) return "";

  // Remove fenced code blocks.
  let out = raw.replace(/```[\s\S]*?```/g, "[code omitted]");

  // Remove common repo excerpt formats.
  out = out
    .split(/\r?\n/g)
    .filter((line) => {
      const l = line.trim();
      if (!l) return true;
      if (/^file:\s+/i.test(l)) return false;
      if (/^sources:\s*$/i.test(l)) return false;
      if (/^\d+\s*\|\s+/.test(l)) return false;
      if (/^\[\s*images?\s+attached/i.test(l)) return true;
      return true;
    })
    .join("\n");

  out = out.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  out = out.trim();
  return clip(out, maxChars);
}

function extractBidCookie(setCookieHeader: string | null): string | undefined {
  if (!setCookieHeader) return undefined;
  const m = /(?:^|,\s*)bid=([^;,\s]+)/.exec(setCookieHeader);
  return m?.[1]?.trim();
}

function buildCookieHeader(): string | undefined {
  return tidbAiBidCookie ? `bid=${tidbAiBidCookie}` : undefined;
}

function looksSensitive(text: string): boolean {
  const t = text;
  if (/sk-[A-Za-z0-9]{16,}/.test(t)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return true;
  if (/\bAPP_SECRET\b/.test(t)) return true;
  if (/\bAPP_ID\b/.test(t)) return true;
  if (/\bOPENAI_API_KEY\b/.test(t)) return true;
  return false;
}

function looksTidbRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(tidb|tikv|tiflash|pd|pingcap|tidb cloud|ticdc|br|dumpling|lightning|dm)\b/.test(lower);
}

export function shouldQueryTidbAi(opts: {
  config: AppConfig;
  question: string;
  transcript: string;
}): boolean {
  if (!opts.config.tidbAiEnabled) return false;
  if (opts.config.mode !== "llm") return false;
  if (!opts.question.trim()) return false;

  const combined = `${opts.question}\n\n${opts.transcript}`.trim();
  if (!looksTidbRelated(combined)) return false;
  if (looksSensitive(combined)) return false;

  return true;
}

function shouldIncludeTranscript(question: string, transcript: string): boolean {
  if (!transcript.trim()) return false;
  const q = question.trim();
  if (!q) return false;
  const lower = q.toLowerCase();
  if (q.length < 40) return true;
  if (/\b(above|below|earlier|previous|prior|same as|as before|continue|still|again)\b/.test(lower)) return true;
  if (/\b(this|that|it|they|these|those)\b/.test(lower)) return true;
  return false;
}

export async function queryTidbAi(opts: {
  baseUrl: string;
  chatEngine: string;
  question: string;
  transcript: string;
  timeoutMs: number;
  maxContextChars: number;
  maxSources: number;
}): Promise<TidbAiResult | undefined> {
  const url = new URL("/api/v1/chats", opts.baseUrl).toString();

  const sanitizedQuestion = sanitizeForTidbAi(opts.question, 2000);
  const includeTranscript = shouldIncludeTranscript(sanitizedQuestion, opts.transcript);
  const sanitizedTranscript = includeTranscript ? sanitizeForTidbAi(opts.transcript, 2000) : "";

  const prompt = [
    "User question:",
    sanitizedQuestion || "(none)",
    "",
    "Chat context (optional):",
    sanitizedTranscript || "(none)",
    "",
    "Please answer using ONLY TiDB/TiDB Cloud official documentation and include the most relevant links."
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, opts.timeoutMs));

  try {
    const cookie = buildCookieHeader();
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {})
      },
      body: JSON.stringify({
        stream: false,
        chat_engine: opts.chatEngine,
        messages: [{ role: "user", content: prompt }]
      }),
      signal: controller.signal
    });

    const bid = extractBidCookie(resp.headers.get("set-cookie"));
    if (bid) tidbAiBidCookie = bid;

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`tidb.ai HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = (await resp.json()) as TidbAiChatResponse;
    const answer = (data.content ?? "").trim();
    if (!answer) return undefined;

    const sources = (data.sources ?? [])
      .map((s) => (s.source_uri ?? "").trim())
      .filter(Boolean);
    const dedupedSources: string[] = [];
    for (const s of sources) {
      if (dedupedSources.includes(s)) continue;
      dedupedSources.push(s);
      if (dedupedSources.length >= Math.max(0, opts.maxSources)) break;
    }

    const clippedAnswer = clip(answer, opts.maxContextChars);
    const contextText = [
      "TiDB.ai (docs-based) answer (treat as external evidence; verify against repo if applicable):",
      clippedAnswer,
      ...(dedupedSources.length > 0 ? ["", "TiDB.ai sources:", ...dedupedSources.map((s) => `- ${s}`)] : [])
    ].join("\n");

    return {
      answer: clippedAnswer,
      contextText,
      sources: dedupedSources,
      trace: typeof data.trace === "string" ? data.trace : undefined
    };
  } catch (error) {
    logger.warn({ error }, "tidb.ai query failed");
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
