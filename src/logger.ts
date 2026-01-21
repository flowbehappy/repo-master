import pino from "pino";

export const logger = pino({
  level: "info",
  // Pino only serializes Error objects automatically under the `err` key.
  // Add `error` as an alias so logs remain useful even if a caller uses `error`.
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err
  }
});

export function configureLogger(level: string | undefined) {
  if (!level) return;
  logger.level = level;
}
