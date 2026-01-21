import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

import { getBoolean, getNumber, getString, getStringArray, parseTomlToFlatConfig, type TomlFlatConfig } from "./toml.js";

export type RunMode = "llm" | "fallback";

export type ModelReasoningEffort = "low" | "medium" | "high" | "xlow" | "xhigh";

export type VisionImageDetail = "low" | "high" | "auto";

export type AppConfig = {
  appId: string;
  appSecret: string;
  baseDomain: string;
  botName: string;

  repoPaths: string[];
  repoMaxFiles: number;
  repoMaxFileBytes: number;
  repoMaxSnippets: number;
  repoSnippetContextLines: number;
  repoMaxContextChars: number;

  mode: RunMode;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModelProvider: string;
  openaiModel: string;
  openaiModelReasoningEffort?: ModelReasoningEffort;

  tidbAiEnabled: boolean;
  tidbAiBaseUrl: string;
  tidbAiTimeoutMs: number;
  tidbAiMaxContextChars: number;
  tidbAiMaxSources: number;
  tidbAiChatEngine: string;

  visionMaxImages: number;
  visionMaxImageBytes: number;
  visionImageDetail?: VisionImageDetail;

  logLevel: string;
  maxChatMessages: number;
  maxPromptChars: number;
};

function readTextFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function normalizeBaseDomain(domain: string): string {
  const trimmed = domain.trim();
  if (!trimmed) return "https://open.feishu.cn";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `https://${trimmed}`;
}

function normalizeUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `https://${trimmed}`;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "y") return true;
  if (raw === "false" || raw === "0" || raw === "no" || raw === "n") return false;
  return fallback;
}

type LoadConfigOptions = { configPath?: string };

function readTomlConfig(configPath: string | undefined): TomlFlatConfig {
  if (!configPath) return {};
  const text = readTextFileIfExists(configPath);
  if (!text) throw new Error(`Config file not found: ${configPath}`);
  return parseTomlToFlatConfig(text);
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeReasoningEffort(raw: string | undefined): ModelReasoningEffort | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;

  if (value === "xlow") return "xlow";
  if (value === "low") return "low";
  if (value === "medium") return "medium";
  if (value === "high") return "high";
  if (value === "xhigh") return "xhigh";

  return undefined;
}

function normalizeVisionImageDetail(raw: string | undefined): VisionImageDetail | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "low") return "low";
  if (value === "high") return "high";
  if (value === "auto") return "auto";
  return undefined;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  dotenv.config();

  const fileCfg = readTomlConfig(options.configPath);
  const configDir = options.configPath ? path.dirname(options.configPath) : process.cwd();

  const appId = pickFirstNonEmpty(
    process.env.APP_ID?.trim(),
    getString(fileCfg, ["app_id", "feishu.app_id", "feishu.APP_ID"])
  );
  const appSecret = pickFirstNonEmpty(
    process.env.APP_SECRET?.trim(),
    getString(fileCfg, ["app_secret", "feishu.app_secret", "feishu.APP_SECRET"])
  );
  if (!appId || !appSecret) {
    throw new Error("Missing APP_ID/APP_SECRET. Set env vars or provide them in the TOML config file.");
  }

  const baseDomain = normalizeBaseDomain(
    pickFirstNonEmpty(
      getString(fileCfg, ["base_domain", "feishu.base_domain", "feishu.domain"]),
      process.env.BASE_DOMAIN?.trim(),
      "https://open.feishu.cn"
    ) ?? "https://open.feishu.cn"
  );
  const botName = pickFirstNonEmpty(
    getString(fileCfg, ["bot_name", "bot.name"]),
    process.env.BOT_NAME?.trim(),
    "deephack"
  )!;

  const repoPathsFromFile = getStringArray(fileCfg, ["repo.paths"]);
  const repoPathFromFile = getString(fileCfg, ["repo.path", "repo_path"]);
  const repoPathFromEnv = process.env.REPO_PATH?.trim();
  const repoPathsFromEnv = process.env.REPO_PATHS?.trim();

  const envPaths = repoPathsFromEnv
    ? repoPathsFromEnv
        .split(/[,\n]/g)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  const rawPaths = repoPathsFromFile ?? (repoPathFromFile ? [repoPathFromFile] : []);
  const pickedPaths =
    rawPaths.length > 0 ? rawPaths : envPaths.length > 0 ? envPaths : repoPathFromEnv ? [repoPathFromEnv] : [];

  const resolvedPaths = pickedPaths
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (path.isAbsolute(p) ? p : path.resolve(configDir, p)));

  const repoPaths = Array.from(new Set(resolvedPaths));

  const repoMaxFiles =
    getNumber(fileCfg, ["repo.max_files"]) ?? readIntEnv("REPO_MAX_FILES", 8000);
  const repoMaxFileBytes =
    getNumber(fileCfg, ["repo.max_file_bytes"]) ?? readIntEnv("REPO_MAX_FILE_BYTES", 1024 * 1024);
  const repoMaxSnippets =
    getNumber(fileCfg, ["repo.max_snippets"]) ?? readIntEnv("REPO_MAX_SNIPPETS", 20);
  const repoSnippetContextLines =
    getNumber(fileCfg, ["repo.snippet_context_lines"]) ?? readIntEnv("REPO_SNIPPET_CONTEXT_LINES", 12);
  const repoMaxContextChars =
    getNumber(fileCfg, ["repo.max_context_chars"]) ?? readIntEnv("REPO_MAX_CONTEXT_CHARS", 80_000);

  const openaiModelProvider = pickFirstNonEmpty(
    getString(fileCfg, ["openai.model_provider", "openai.provider"]),
    process.env.OPENAI_MODEL_PROVIDER?.trim(),
    "openai"
  )!;

  const openaiBaseUrl = normalizeUrl(
    pickFirstNonEmpty(
      getString(fileCfg, [
        "openai.base_url",
        `openai.model_providers.${openaiModelProvider}.base_url`
      ]),
      process.env.OPENAI_BASE_URL?.trim()
    )
  );

  const openaiApiKey = pickFirstNonEmpty(
    getString(fileCfg, [
      "OPENAI_API_KEY",
      "openai_api_key",
      "openai.api_key",
      "openai.key",
      `openai.model_providers.${openaiModelProvider}.api_key`
    ]),
    process.env.OPENAI_API_KEY?.trim()
  );
  const openaiModel = pickFirstNonEmpty(
    getString(fileCfg, ["openai.model", "openai_model"]),
    process.env.OPENAI_MODEL?.trim(),
    "gpt-4o-mini"
  )!;
  const openaiModelReasoningEffort = normalizeReasoningEffort(
    pickFirstNonEmpty(
      getString(fileCfg, ["openai.model_reasoning_effort", "openai.reasoning_effort"]),
      process.env.OPENAI_REASONING_EFFORT?.trim()
    )
  );

  const tidbAiEnabled =
    getBoolean(fileCfg, ["tidb_ai.enabled", "tidb_ai_enabled"]) ?? readBoolEnv("TIDB_AI_ENABLED", true);
  const tidbAiBaseUrl = normalizeUrl(
    pickFirstNonEmpty(
      getString(fileCfg, ["tidb_ai.base_url", "tidb_ai.url"]),
      process.env.TIDB_AI_BASE_URL?.trim(),
      "https://tidb.ai"
    )
  )!;
  const tidbAiTimeoutMs =
    getNumber(fileCfg, ["tidb_ai.timeout_ms"]) ?? readIntEnv("TIDB_AI_TIMEOUT_MS", 120_000);
  const tidbAiMaxContextChars =
    getNumber(fileCfg, ["tidb_ai.max_context_chars"]) ?? readIntEnv("TIDB_AI_MAX_CONTEXT_CHARS", 24_000);
  const tidbAiMaxSources =
    getNumber(fileCfg, ["tidb_ai.max_sources"]) ?? readIntEnv("TIDB_AI_MAX_SOURCES", 12);
  const tidbAiChatEngine = pickFirstNonEmpty(
    getString(fileCfg, ["tidb_ai.chat_engine"]),
    process.env.TIDB_AI_CHAT_ENGINE?.trim(),
    "default"
  )!;

  const visionMaxImages =
    getNumber(fileCfg, ["vision.max_images", "vision.max_images_per_prompt"]) ?? readIntEnv("VISION_MAX_IMAGES", 8);
  const visionMaxImageBytes =
    getNumber(fileCfg, ["vision.max_image_bytes"]) ?? readIntEnv("VISION_MAX_IMAGE_BYTES", 10 * 1024 * 1024);
  const visionImageDetail = normalizeVisionImageDetail(
    pickFirstNonEmpty(
      getString(fileCfg, ["vision.image_detail"]),
      process.env.VISION_IMAGE_DETAIL?.trim()
    )
  );

  const explicitMode = pickFirstNonEmpty(
    getString(fileCfg, ["mode", "run.mode"]),
    process.env.MODE?.trim()
  ) as RunMode | undefined;
  const mode: RunMode =
    explicitMode === "llm" || explicitMode === "fallback" ? explicitMode : openaiApiKey ? "llm" : "fallback";

  const logLevel = pickFirstNonEmpty(getString(fileCfg, ["log_level", "logging.level"]), process.env.LOG_LEVEL?.trim(), "info")!;

  return {
    appId,
    appSecret,
    baseDomain,
    botName,

    repoPaths,
    repoMaxFiles,
    repoMaxFileBytes,
    repoMaxSnippets,
    repoSnippetContextLines,
    repoMaxContextChars,

    mode,
    openaiApiKey,
    openaiBaseUrl,
    openaiModelProvider,
    openaiModel,
    openaiModelReasoningEffort,

    tidbAiEnabled,
    tidbAiBaseUrl,
    tidbAiTimeoutMs,
    tidbAiMaxContextChars,
    tidbAiMaxSources,
    tidbAiChatEngine,

    visionMaxImages,
    visionMaxImageBytes,
    visionImageDetail,

    logLevel,

    maxChatMessages:
      getNumber(fileCfg, ["max_chat_messages", "limits.max_chat_messages"]) ?? readIntEnv("MAX_CHAT_MESSAGES", 20),
    maxPromptChars:
      getNumber(fileCfg, ["max_prompt_chars", "limits.max_prompt_chars"]) ?? readIntEnv("MAX_PROMPT_CHARS", 80_000)
  };
}
