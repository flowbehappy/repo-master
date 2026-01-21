export function buildAnswerCardContent(opts: {
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

  // Shared card so we can patch-update it in place (progress → final answer).
  return JSON.stringify({
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    elements: [
      {
        tag: "markdown",
        content: finalMarkdown
      }
    ]
  });
}
