import type { AppConfig } from "../config.js";

function looksLikeSelfIntroQuestion(question: string): boolean {
  const q = question.trim();
  if (!q) return false;

  const lower = q.toLowerCase();

  const askName =
    /\b(who are you|what('?s| is) your name|your name)\b/.test(lower) ||
    /(你是谁|你叫什么|你叫啥)/.test(q);

  const askWhatCanDo =
    /\b(what can you do|what do you do|how can you help|capabilit|abilities|help with)\b/.test(lower) ||
    /(你能做什么|你可以做什么|有什么功能|能帮我做什么)/.test(q);

  if (!askName && !askWhatCanDo) return false;

  // Avoid catching long, mixed questions.
  if (q.length > 240) return false;

  return true;
}

export function maybeBuildSelfIntroAnswer(config: AppConfig, question: string): string | undefined {
  if (!looksLikeSelfIntroQuestion(question)) return undefined;

  const mention = config.botName.trim() || "deephack";

  return [
    "I'm Repo Master.",
    "",
    "What I can do:",
    "- Answer TiDB/TiKV/PD/TiCDC/TiFlash/TiDB Cloud questions using TiDB.ai (docs-backed links).",
    "- Search configured code repos and cite relevant code as `path:line`.",
    "- Understand text/post/image messages (vision) when enabled.",
    "- Ask 1–3 clarifying questions when needed.",
    "",
    `In group chats, mention me with @${mention}.`
  ].join("\n");
}
