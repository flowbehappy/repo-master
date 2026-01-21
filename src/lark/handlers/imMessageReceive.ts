import type { LarkDeps } from "../start.js";
import { logger } from "../../logger.js";
import {
  buildTranscript,
  computeEndTimeSecFromCreateTimeMs,
  formatTranscriptForPrompt,
  listAllThreadMessages,
  listRecentChatMessages,
  logHistorySummary,
  normalizeIncomingMessage,
  shouldHandleIncomingMessage,
  stripBotMention
} from "../messages.js";
import { markIfNew } from "../../dedupe.js";
import { generateAnswer } from "../../answer/generateAnswer.js";
import { buildAnswerCardContent } from "../../cards.js";
import { replyWithInteractiveCard, replyWithText } from "../reply.js";
import { downloadMessageImageAsDataUrl, type LarkImageRef } from "../resources.js";
import { analyzeHistoryNeed } from "../../analysis/historyNeed.js";
import { collectAnswerContext } from "../../research/collectAnswerContext.js";
import { maybeBuildSelfIntroAnswer } from "../../answer/selfIntro.js";

export async function handleImMessageReceiveV1(_deps: LarkDeps, data: unknown) {
  const incoming = normalizeIncomingMessage(data);
  if (!incoming) {
    logger.warn({ data }, "Dropped event: unable to normalize incoming message");
    return;
  }

  const { client, config } = _deps;
  if (!shouldHandleIncomingMessage(config, incoming)) return;

  if (!markIfNew(incoming.eventId)) {
    logger.info({ eventId: incoming.eventId }, "Dropped duplicate event");
    return;
  }

  const hasText = !!incoming.text?.trim();
  const hasImages = incoming.imageKeys.length > 0;
  if (!hasText && !hasImages) {
    logger.info({ messageType: incoming.messageType }, "Ignoring message without extractable text or images");
    return;
  }

  let question = stripBotMention(config, incoming);
  if (!question && hasImages) question = "Please analyze the attached image(s) and respond helpfully.";
  if (!question) {
    logger.info({ messageId: incoming.messageId }, "Ignoring empty question after stripping mention");
    return;
  }

  const collectImageRefs = (history: Array<{ messageId?: string; imageKeys: string[] }>, maxImages: number): LarkImageRef[] => {
    if (maxImages <= 0) return [];
    const refs: LarkImageRef[] = [];
    const seen = new Set<string>();

    // Prefer most-recent images (closest to the current question).
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const msg = history[i];
      if (!msg.messageId) continue;
      for (const key of msg.imageKeys ?? []) {
        const fileKey = (key ?? "").trim();
        if (!fileKey) continue;
        const dedupeKey = `${msg.messageId}:${fileKey}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        refs.push({ messageId: msg.messageId, imageKey: fileKey });
        if (refs.length >= maxImages) return refs.reverse();
      }
    }
    return refs.reverse();
  };

  // Run the slow pipeline in the background so the WS event can be acked quickly.
  void (async () => {
    try {
    const selfIntro = maybeBuildSelfIntroAnswer(config, question);
    if (selfIntro) {
      const card = buildAnswerCardContent({
        title: "Repo Master",
        answer: selfIntro,
        sources: [],
        mode: config.mode === "llm" && config.openaiApiKey ? "llm" : "fallback"
      });

      try {
        await replyWithInteractiveCard({
          client,
          messageId: incoming.messageId,
          cardContentJsonString: card,
          dedupeKey: incoming.eventId
        });
      } catch (error) {
        logger.warn({ error }, "Interactive card reply failed; falling back to text");
        await replyWithText({
          client,
          messageId: incoming.messageId,
          text: selfIntro,
          dedupeKey: incoming.eventId
        });
      }
      return;
    }

    const historyNeed = await analyzeHistoryNeed({ config, question, hasImages });

    const history = historyNeed.needsHistory
      ? (incoming.threadId
          ? await listAllThreadMessages(client, incoming.threadId)
          : await listRecentChatMessages(
              client,
              incoming.chatId,
              computeEndTimeSecFromCreateTimeMs(incoming.createTimeMs),
              config.maxChatMessages
            ))
      : [];

    logHistorySummary(incoming.threadId ? "thread" : "chat", history.length);

    const transcript = buildTranscript(history);
    const transcriptForPrompt = formatTranscriptForPrompt(transcript, config.maxPromptChars);

    const imageRefs = collectImageRefs(
      [{ messageId: incoming.messageId, imageKeys: incoming.imageKeys }, ...history],
      Math.max(0, config.visionMaxImages)
    );

    const downloaded = imageRefs.length > 0
      ? await Promise.all(
          imageRefs.map((ref) =>
            downloadMessageImageAsDataUrl({ client, ref, maxBytes: config.visionMaxImageBytes })
          )
        )
      : [];
    const images = downloaded
      .filter((d): d is NonNullable<typeof d> => !!d)
      .map((d) => ({ dataUrl: d.dataUrl, ...(config.visionImageDetail ? { detail: config.visionImageDetail } : {}) }));

    const ctx = await collectAnswerContext({ config, question, transcript: transcriptForPrompt, images });

    const answer = await generateAnswer({
      config,
      question,
      transcript: transcriptForPrompt,
      repoContext: ctx.repoContext,
      externalContext: ctx.externalContext,
      sources: ctx.sources,
      images,
      followUpQuestions: ctx.followUpQuestions
    });

    const card = buildAnswerCardContent({
      title: "Repo Master",
      answer: answer.answer,
      sources: answer.sources,
      mode: answer.mode
    });

    try {
      await replyWithInteractiveCard({
        client,
        messageId: incoming.messageId,
        cardContentJsonString: card,
        dedupeKey: incoming.eventId
      });
    } catch (error) {
      logger.warn({ error }, "Interactive card reply failed; falling back to text");
      await replyWithText({
        client,
        messageId: incoming.messageId,
        text: answer.answer,
        dedupeKey: incoming.eventId
      });
    }
  } catch (error) {
    logger.error({ error }, "Failed to process message");
    await replyWithText({
      client,
      messageId: incoming.messageId,
      text: "Sorry — I failed to process that request (check bot logs for details).",
      dedupeKey: incoming.eventId
    });
  }
  })();
}
