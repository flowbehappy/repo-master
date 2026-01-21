import * as Lark from "@larksuiteoapi/node-sdk";

import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { handleImMessageReceiveV1 } from "./handlers/imMessageReceive.js";

export type LarkDeps = {
  client: InstanceType<typeof Lark.Client>;
  config: AppConfig;
};

export function startFeishuBot(config: AppConfig) {
  const baseConfig = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.baseDomain
  };

  const client = new Lark.Client(baseConfig);
  const wsClient = new Lark.WSClient(baseConfig);

  const deps: LarkDeps = { client, config };

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => handleImMessageReceiveV1(deps, data)
  });

  wsClient.start({ eventDispatcher });
  logger.info(
    { baseDomain: config.baseDomain, botName: config.botName, mode: config.mode },
    "Feishu WS bot started"
  );
}

