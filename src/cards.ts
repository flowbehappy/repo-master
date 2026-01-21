import * as Lark from "@larksuiteoapi/node-sdk";

export function buildAnswerCardContent(opts: {
  title: string;
  answer: string;
  sources: string[];
  mode: "llm" | "fallback";
}): string {
  const maxChars = 6000;

  const normalizedAnswer = opts.answer.trim();
  const hasSourcesSection = /\bsources\s*:/i.test(normalizedAnswer);

  const sourcesBlock =
    !hasSourcesSection && opts.sources.length > 0
      ? ["", "Sources:", ...opts.sources.map((s) => `- ${s}`)].join("\n")
      : "";

  const modeLine = `\n\n_ Mode: ${opts.mode} _`;

  const markdown = `${normalizedAnswer}${sourcesBlock}${modeLine}`.trim();
  const finalMarkdown = markdown.length > maxChars ? `${markdown.slice(0, maxChars - 20)}\n\n…(truncated)` : markdown;

  return Lark.messageCard.defaultCard({ title: opts.title, content: finalMarkdown });
}
