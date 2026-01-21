import pino from "pino";

export const logger = pino({
  level: "info"
});

export function configureLogger(level: string | undefined) {
  if (!level) return;
  logger.level = level;
}
