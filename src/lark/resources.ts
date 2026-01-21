import { Readable } from "node:stream";

import type * as Lark from "@larksuiteoapi/node-sdk";

import { logger } from "../logger.js";

export type LarkImageRef = {
  messageId: string;
  imageKey: string;
};

export type DownloadedImage = {
  messageId: string;
  imageKey: string;
  mimeType: string;
  byteLength: number;
  dataUrl: string;
};

function getHeader(headers: any, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const direct = headers[name];
  if (typeof direct === "string") return direct;
  const lower = headers[name.toLowerCase()];
  if (typeof lower === "string") return lower;
  return undefined;
}

function normalizeMimeType(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "application/octet-stream";
  const base = value.split(";")[0]?.trim();
  if (!base) return "application/octet-stream";
  return base;
}

async function readStreamToBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error(`Resource exceeds max bytes (${maxBytes})`);
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

export async function downloadMessageImageAsDataUrl(opts: {
  client: InstanceType<typeof Lark.Client>;
  ref: LarkImageRef;
  maxBytes: number;
}): Promise<DownloadedImage | undefined> {
  try {
    const resp = await opts.client.im.v1.messageResource.get({
      path: { message_id: opts.ref.messageId, file_key: opts.ref.imageKey },
      params: { type: "image" }
    });

    const stream = resp.getReadableStream();
    const headers = resp.headers;
    const mimeType = normalizeMimeType(getHeader(headers, "content-type"));

    const buf = await readStreamToBuffer(stream, opts.maxBytes);
    const dataUrl = `data:${mimeType};base64,${buf.toString("base64")}`;

    return {
      messageId: opts.ref.messageId,
      imageKey: opts.ref.imageKey,
      mimeType,
      byteLength: buf.length,
      dataUrl
    };
  } catch (error) {
    logger.warn({ err: error, messageId: opts.ref.messageId }, "Failed to download image resource");
    return undefined;
  }
}
