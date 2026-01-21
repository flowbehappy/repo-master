import type * as Lark from "@larksuiteoapi/node-sdk";

import { buildAnswerCardContent } from "../cards.js";
import { logger } from "../logger.js";
import { patchInteractiveCard, replyWithInteractiveCard } from "./reply.js";

export type ProgressReporter = {
  messageId?: string;
  setStage: (stage: string) => void;
  stop: () => void;
  finalize: (cardContentJsonString: string) => Promise<void>;
  fail: (errorText: string) => Promise<void>;
};

function formatElapsedMs(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${String(rem).padStart(2, "0")}s`;
}

function buildProgressMarkdown(opts: { stage: string; startedAtMs: number }): string {
  const elapsed = formatElapsedMs(Date.now() - opts.startedAtMs);
  const stage = opts.stage.trim() || "Working…";
  return [`Working on it…`, "", `Status: ${stage}`, `Elapsed: ${elapsed}`].join("\n");
}

export async function startProgressReporter(opts: {
  client: InstanceType<typeof Lark.Client>;
  replyToMessageId: string;
  dedupeKey: string;
  title: string;
  mode: "llm" | "fallback";
}): Promise<ProgressReporter> {
  const startedAtMs = Date.now();
  let stage = "Starting…";
  let stopped = false;
  let disabled = false;
  let messageId: string | undefined;

  let lastRendered = "";
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };

  const render = () => buildProgressMarkdown({ stage, startedAtMs });

  const patchNow = (force: boolean) => {
    void enqueue(async () => {
      if (!messageId || disabled || stopped) return;
      const markdown = render();
      if (!force && markdown === lastRendered) return;
      lastRendered = markdown;

      const card = buildAnswerCardContent({
        title: opts.title,
        answer: markdown,
        sources: [],
        mode: opts.mode
      });

      try {
        await patchInteractiveCard({ client: opts.client, messageId, cardContentJsonString: card });
      } catch (error) {
        disabled = true;
        logger.warn({ err: error, messageId }, "Failed to patch progress card; disabling progress updates");
      }
    });
  };

  // Send an initial card reply so users see we started working.
  try {
    const initialCard = buildAnswerCardContent({
      title: opts.title,
      answer: render(),
      sources: [],
      mode: opts.mode
    });
    messageId = await replyWithInteractiveCard({
      client: opts.client,
      messageId: opts.replyToMessageId,
      cardContentJsonString: initialCard,
      dedupeKey: `${opts.dedupeKey}_progress`
    });
  } catch (error) {
    logger.warn({ err: error }, "Failed to send initial progress card; continuing without progress updates");
  }

  // Heartbeat update so long-running stages still show movement (elapsed time).
  const interval = setInterval(() => {
    patchNow(false);
  }, 10_000);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };

  const setStage = (next: string) => {
    const v = next.trim();
    if (!v) return;
    if (v === stage) return;
    stage = v;
    patchNow(true);
  };

  const finalize = async (cardContentJsonString: string) => {
    stop();
    if (!messageId || disabled) return;
    await enqueue(async () => {
      if (!messageId || disabled) return;
      await patchInteractiveCard({ client: opts.client, messageId, cardContentJsonString });
    });
  };

  const fail = async (errorText: string) => {
    stop();
    if (!messageId || disabled) return;
    const card = buildAnswerCardContent({
      title: opts.title,
      answer: errorText,
      sources: [],
      mode: opts.mode
    });
    await enqueue(async () => {
      if (!messageId || disabled) return;
      await patchInteractiveCard({ client: opts.client, messageId, cardContentJsonString: card });
    });
  };

  return { messageId, setStage, stop, finalize, fail };
}
