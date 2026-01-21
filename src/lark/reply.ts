import { randomUUID } from "node:crypto";

import type * as Lark from "@larksuiteoapi/node-sdk";

import { logger } from "../logger.js";

function normalizeUuid(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return randomUUID();
  return trimmed.length <= 50 ? trimmed : trimmed.slice(0, 50);
}

export async function replyWithInteractiveCard(opts: {
  client: InstanceType<typeof Lark.Client>;
  messageId: string;
  cardContentJsonString: string;
  dedupeKey: string;
}) {
  const uuid = normalizeUuid(opts.dedupeKey);
  const resp = await opts.client.im.v1.message.reply({
    path: { message_id: opts.messageId },
    data: {
      msg_type: "interactive",
      content: opts.cardContentJsonString,
      uuid
    }
  });

  if (!resp || resp.code !== 0) {
    throw new Error(`Feishu message.reply(interactive) failed: code=${resp?.code} msg=${resp?.msg}`);
  }
}

export async function replyWithText(opts: {
  client: InstanceType<typeof Lark.Client>;
  messageId: string;
  text: string;
  dedupeKey: string;
}) {
  const uuid = normalizeUuid(opts.dedupeKey);
  const resp = await opts.client.im.v1.message.reply({
    path: { message_id: opts.messageId },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text: opts.text }),
      uuid
    }
  });

  if (!resp || resp.code !== 0) {
    logger.error({ code: resp?.code, msg: resp?.msg }, "Feishu message.reply(text) failed");
  }
}
