import { randomUUID } from "node:crypto";

import type * as Lark from "@larksuiteoapi/node-sdk";

import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";

export type LarkImMessageReceiveEvent = {
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
    token?: string;
    app_id?: string;
    tenant_key?: string;
  };
  event?: unknown;

  // Some SDKs flatten these at top-level for handlers.
  message?: unknown;
  sender?: unknown;
};

export type LarkMessageMention = { key?: string; name?: string; id?: unknown };

export type NormalizedIncomingMessage = {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group" | string;
  threadId?: string;
  createTimeMs?: number;
  messageType: string;
  text?: string;
  imageKeys: string[];
  mentions: LarkMessageMention[];
  senderType?: string;
};

export type HistoryMessage = {
  messageId?: string;
  msgType?: string;
  createTimeMs?: number;
  senderType?: string;
  text?: string;
  imageKeys: string[];
};

export type TranscriptEntry = {
  role: "user" | "assistant" | "unknown";
  text: string;
};

function safeJsonParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickPostLocale(post: Record<string, unknown>): Record<string, unknown> | undefined {
  const zh = asRecord(post.zh_cn);
  const en = asRecord(post.en_us);
  if (zh) return zh;
  if (en) return en;

  if (typeof post.title === "string" || Array.isArray(post.content)) return post;

  const firstKey = Object.keys(post)[0];
  if (!firstKey) return undefined;
  return asRecord(post[firstKey]);
}

function extractTextFromPostContent(parsed: unknown): string | undefined {
  const root = asRecord(parsed) ?? {};
  const postValue = root.post ?? root;
  const post = asRecord(postValue);
  if (!post) return undefined;

  const locale = pickPostLocale(post);

  if (!locale) return undefined;

  const title = typeof locale.title === "string" ? (locale.title as string).trim() : "";

  const content = locale.content;
  const lines: string[] = [];

  const renderElement = (el: unknown): string => {
    const r = asRecord(el);
    if (!r) return "";
    const tag = typeof r.tag === "string" ? (r.tag as string) : "";

    if (tag === "text") return typeof r.text === "string" ? (r.text as string) : "";
    if (tag === "a") {
      const text = typeof r.text === "string" ? (r.text as string) : "";
      const href = typeof r.href === "string" ? (r.href as string) : "";
      if (text && href && text !== href) return `${text} (${href})`;
      return text || href;
    }
    if (tag === "at") {
      const name = typeof r.user_name === "string" ? (r.user_name as string) : "";
      const id = typeof r.user_id === "string" ? (r.user_id as string) : "";
      const who = (name || id).trim();
      return who ? `@${who}` : "@";
    }
    if (tag === "emoji") return typeof r.emoji_type === "string" ? `:${r.emoji_type as string}:` : "";
    if (tag === "code_block") {
      const text = typeof r.text === "string" ? (r.text as string) : "";
      return text ? `\n${text}\n` : "";
    }

    return typeof r.text === "string" ? (r.text as string) : "";
  };

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!Array.isArray(block)) continue;
      const parts = block.map((el) => renderElement(el)).join("").trim();
      if (parts) lines.push(parts);
    }
  }

  const out = [title, lines.join("\n")].map((s) => s.trim()).filter(Boolean).join("\n").trim();
  return out || undefined;
}

function extractImageKeysFromPostContent(parsed: unknown): string[] {
  const root = asRecord(parsed) ?? {};
  const postValue = root.post ?? root;
  const post = asRecord(postValue);
  if (!post) return [];

  const locale = pickPostLocale(post);
  if (!locale) return [];

  const content = locale.content;
  const out: string[] = [];

  const pushKey = (key: unknown) => {
    const imageKey = typeof key === "string" ? key.trim() : "";
    if (!imageKey) return;
    if (out.includes(imageKey)) return;
    out.push(imageKey);
  };

  const visitElement = (el: unknown) => {
    const r = asRecord(el);
    if (!r) return;
    const tag = typeof r.tag === "string" ? (r.tag as string) : "";

    if (tag === "img" || tag === "image") pushKey(r.image_key);
    if (typeof r.image_key === "string") pushKey(r.image_key);
  };

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!Array.isArray(block)) continue;
      for (const el of block) visitElement(el);
    }
  }

  return out;
}

function extractTextFromMessageContent(messageType: string, raw: string): string | undefined {
  const parsed = safeJsonParse<any>(raw);
  if (!parsed) return undefined;

  const type = messageType.trim().toLowerCase();
  if (type === "text") return typeof parsed.text === "string" ? (parsed.text as string) : undefined;
  if (type === "post") return extractTextFromPostContent(parsed);

  if (typeof parsed.text === "string") return parsed.text as string;
  return undefined;
}

function extractImageKeysFromMessageContent(messageType: string, raw: string): string[] {
  const parsed = safeJsonParse<any>(raw);
  if (!parsed) return [];

  const type = messageType.trim().toLowerCase();
  if (type === "image") {
    const key = typeof parsed.image_key === "string" ? parsed.image_key.trim() : "";
    return key ? [key] : [];
  }
  if (type === "post") return extractImageKeysFromPostContent(parsed);

  if (typeof parsed.image_key === "string") {
    const key = parsed.image_key.trim();
    return key ? [key] : [];
  }

  return [];
}

function normalizeMentions(raw: unknown): LarkMessageMention[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => asRecord(m))
    .filter(Boolean)
    .map((m) => ({
      key: typeof m!.key === "string" ? (m!.key as string) : undefined,
      name: typeof m!.name === "string" ? (m!.name as string) : undefined,
      id: m!.id
    }));
}

function extractFlattenedEvent(data: unknown): { header?: Record<string, unknown>; message?: Record<string, unknown>; sender?: Record<string, unknown> } {
  const root = asRecord(data) ?? {};
  const header = asRecord(root.header);

  const event = asRecord(root.event);
  const message = asRecord(root.message) ?? (event ? asRecord(event.message) : undefined);
  const sender = asRecord(root.sender) ?? (event ? asRecord(event.sender) : undefined);

  return { header, message, sender };
}

export function normalizeIncomingMessage(data: unknown): NormalizedIncomingMessage | undefined {
  const { header, message, sender } = extractFlattenedEvent(data);
  if (!message) return undefined;

  const messageId = typeof message.message_id === "string" ? message.message_id : undefined;
  const chatId = typeof message.chat_id === "string" ? message.chat_id : undefined;
  const chatType = typeof message.chat_type === "string" ? message.chat_type : undefined;
  const threadId = typeof message.thread_id === "string" ? message.thread_id : undefined;

  const messageType =
    (typeof message.message_type === "string" ? message.message_type : undefined) ??
    (typeof message.msg_type === "string" ? message.msg_type : undefined) ??
    "unknown";

  const content = typeof message.content === "string" ? message.content : undefined;
  const body = asRecord(message.body);
  const bodyContent = typeof body?.content === "string" ? (body.content as string) : undefined;

  const rawText = (() => {
    const raw = content ?? bodyContent;
    if (!raw) return undefined;
    return extractTextFromMessageContent(messageType, raw);
  })();
  const imageKeys = (() => {
    const raw = content ?? bodyContent;
    if (!raw) return [];
    return extractImageKeysFromMessageContent(messageType, raw);
  })();

  const mentions = normalizeMentions(message.mentions);
  const senderType = sender && typeof sender.sender_type === "string" ? (sender.sender_type as string) : undefined;

  const eventId =
    (header && typeof header.event_id === "string" ? (header.event_id as string) : undefined) ??
    (messageId ? `msg_${messageId}` : randomUUID());

  const createTimeMs =
    typeof message.create_time === "string" ? Number.parseInt(message.create_time, 10) : undefined;

  if (!messageId || !chatId || !chatType) return undefined;

  return {
    eventId,
    messageId,
    chatId,
    chatType,
    threadId,
    createTimeMs: Number.isFinite(createTimeMs) ? createTimeMs : undefined,
    messageType,
    text: rawText,
    imageKeys,
    mentions,
    senderType
  };
}

export function shouldHandleIncomingMessage(config: AppConfig, msg: NormalizedIncomingMessage): boolean {
  if (msg.senderType === "app") return false;
  if (msg.chatType === "p2p") return true;
  if (msg.chatType !== "group") return false;

  const botName = config.botName.trim();
  const botNameLower = botName.toLowerCase();

  if (msg.mentions.some((m) => (m.name ?? "").trim().toLowerCase() === botNameLower)) return true;

  const text = (msg.text ?? "").trim();
  if (!text || !botName) return false;
  return new RegExp(`@\\s*${escapeRegExp(botName)}\\b`, "i").test(text);
}

export function stripBotMention(config: AppConfig, msg: NormalizedIncomingMessage): string {
  const raw = msg.text ?? "";
  if (msg.chatType === "p2p") return raw.trim();

  const botName = config.botName.trim();
  const botNameLower = botName.toLowerCase();
  const botMentionKeys = msg.mentions
    .filter((m) => (m.name ?? "").trim().toLowerCase() === botNameLower)
    .map((m) => m.key)
    .filter((k): k is string => !!k);

  let out = raw;
  for (const key of botMentionKeys) {
    out = out.split(key).join("");
  }
  if (botName) {
    out = out.replace(new RegExp(`@\\s*${escapeRegExp(botName)}\\b`, "ig"), "");
  }
  return out.replace(/\s+/g, " ").trim();
}

export async function listAllThreadMessages(
  client: InstanceType<typeof Lark.Client>,
  threadId: string
): Promise<HistoryMessage[]> {
  const items: HistoryMessage[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const resp = await client.im.v1.message.list({
      params: {
        container_id_type: "thread",
        container_id: threadId,
        sort_type: "ByCreateTimeAsc",
        page_size: 50,
        page_token: pageToken
      }
    });

    if (!resp || resp.code !== 0) {
      throw new Error(`Feishu message.list(thread) failed: code=${resp?.code} msg=${resp?.msg}`);
    }

    const data = resp.data;
    const batch = data?.items ?? [];
    for (const raw of batch) {
      items.push(normalizeHistoryMessage(raw));
    }

    if (!data?.has_more || !data.page_token) break;
    pageToken = data.page_token;
  }

  return items;
}

export async function listRecentChatMessages(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  endTimeSec: number | undefined,
  limit: number
): Promise<HistoryMessage[]> {
  const resp = await client.im.v1.message.list({
    params: {
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeDesc",
      page_size: limit,
      ...(endTimeSec ? { end_time: String(endTimeSec) } : {})
    }
  });

  if (!resp || resp.code !== 0) {
    throw new Error(`Feishu message.list(chat) failed: code=${resp?.code} msg=${resp?.msg}`);
  }

  const items = (resp.data?.items ?? []).map((raw) => normalizeHistoryMessage(raw));
  return items.reverse();
}

function normalizeHistoryMessage(raw: unknown): HistoryMessage {
  const msg = asRecord(raw) ?? {};
  const body = asRecord(msg.body) ?? {};
  const msgType = typeof msg.msg_type === "string" ? (msg.msg_type as string) : undefined;
  const messageId = typeof msg.message_id === "string" ? (msg.message_id as string) : undefined;
  const createTimeMs = typeof msg.create_time === "string" ? Number.parseInt(msg.create_time as string, 10) : undefined;

  const sender = asRecord(msg.sender);
  const senderType = sender && typeof sender.sender_type === "string" ? (sender.sender_type as string) : undefined;

  const text = (() => {
    const content = typeof body.content === "string" ? (body.content as string) : undefined;
    if (!content) return undefined;
    return extractTextFromMessageContent(msgType ?? "unknown", content);
  })();
  const imageKeys = (() => {
    const content = typeof body.content === "string" ? (body.content as string) : undefined;
    if (!content) return [];
    return extractImageKeysFromMessageContent(msgType ?? "unknown", content);
  })();

  return {
    messageId,
    msgType,
    createTimeMs: Number.isFinite(createTimeMs) ? createTimeMs : undefined,
    senderType,
    text,
    imageKeys
  };
}

export function buildTranscript(history: HistoryMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const msg of history) {
    const msgType = (msg.msgType ?? "").trim();
    if (msgType !== "text" && msgType !== "post" && msgType !== "image") continue;

    const text = (() => {
      const t = (msg.text ?? "").trim();
      if (t) return t;
      if (msgType === "image" && msg.imageKeys.length > 0) {
        return msg.imageKeys.length === 1 ? "[Image attached]" : `[Images attached: ${msg.imageKeys.length}]`;
      }
      return "";
    })();
    if (!text) continue;

    const role: TranscriptEntry["role"] =
      msg.senderType === "app" ? "assistant" : msg.senderType === "user" ? "user" : "unknown";
    entries.push({ role, text });
  }

  return entries;
}

export function formatTranscriptForPrompt(entries: TranscriptEntry[], maxChars: number): string {
  let out = "";
  for (const entry of entries) {
    const normalizedText = entry.text.replace(/\r?\n/g, "\n  ");
    const line = `${entry.role.toUpperCase()}: ${normalizedText}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}

export function computeEndTimeSecFromCreateTimeMs(ms: number | undefined): number | undefined {
  if (!ms || !Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

export function logHistorySummary(kind: "thread" | "chat", count: number) {
  logger.info({ kind, count }, "Fetched history messages");
}
