import path from "node:path";

export type CliOptions = {
  configPath?: string;
  help: boolean;
};

function printHelp(): void {
  // Keep this as plain text so it’s usable in logs/systemd.
  // eslint-disable-next-line no-console
  console.log(`Repo-Master (deephack)

Usage:
  node dist/index.js [--config <file.toml>]
  npm run dev -- [--config <file.toml>]

Options:
  --config <path>   Load configuration from a TOML file
  -h, --help        Show help
`);
}

export function parseCliArgs(argv: string[]): CliOptions {
  let configPath: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }

    if (arg === "--config") {
      const next = argv[i + 1];
      if (!next) throw new Error("--config requires a path");
      configPath = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
  }

  if (configPath) configPath = path.resolve(process.cwd(), configPath);

  return { configPath, help };
}

export function maybeHandleHelp(opts: CliOptions): boolean {
  if (!opts.help) return false;
  printHelp();
  return true;
}

