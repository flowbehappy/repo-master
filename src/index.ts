import process from "node:process";

import { maybeHandleHelp, parseCliArgs } from "./cli.js";
import { loadConfig } from "./config.js";
import { configureLogger, logger } from "./logger.js";
import { startFeishuBot } from "./lark/start.js";

function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (maybeHandleHelp(cli)) return;

  const config = loadConfig({ configPath: cli.configPath });
  configureLogger(config.logLevel);

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    logger.error({ err: error }, "Uncaught exception");
    process.exitCode = 1;
  });

  startFeishuBot(config);
}

main();
