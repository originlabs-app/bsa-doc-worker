import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  AwAdapterError,
  AwSolutionsAdapter,
} from "./adapters/aw-solutions.js";
import { MockAwBrowserSession } from "./adapters/mock-aw-session.js";
import { PlaywrightAwBrowserSession } from "./adapters/playwright-aw-session.js";
import {
  loadWorkerConfig,
  parseWorkerSecretEnv,
  type WorkerConfig,
} from "./config.js";
import { RecoveryRequestSchema } from "./contracts.js";
import { JsonLineLogger, type TextOutput } from "./logger.js";
import type { BuyerProfileAdapter } from "./ports.js";
import { runRecovery } from "./worker.js";

export interface CliIo {
  readInput(path: string): Promise<string>;
  stdout: TextOutput;
  stderr: TextOutput;
}

interface CliArgs {
  input: string;
  envFile?: string;
  mode?: string;
  provider?: string;
}

const REAL_IO: CliIo = {
  readInput: (path) => readFile(path, "utf8"),
  stdout: process.stdout,
  stderr: process.stderr,
};

function parseArgs(argv: string[]): CliArgs {
  const parsed: Partial<CliArgs> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("invalid arguments");
    }
    if (flag === "--input") parsed.input = value;
    else if (flag === "--env-file") parsed.envFile = value;
    else if (flag === "--mode") parsed.mode = value;
    else if (flag === "--provider") parsed.provider = value;
    else throw new Error("unknown argument");
  }
  if (!parsed.input) throw new Error("missing input");
  return parsed as CliArgs;
}

function createRealAdapter(config: WorkerConfig): BuyerProfileAdapter {
  if (
    !config.browserlessToken ||
    !config.awPortalEmail ||
    !config.awPortalPassword
  ) {
    return {
      discover: async () => {
        throw new AwAdapterError(
          "MISSING_REAL_SECRETS",
          false,
          "Real adapter secrets are unavailable",
        );
      },
    };
  }
  return new AwSolutionsAdapter(
    new PlaywrightAwBrowserSession({
      browserlessToken: config.browserlessToken,
      awPortalEmail: config.awPortalEmail,
      awPortalPassword: config.awPortalPassword,
    }),
  );
}

function createAdapter(config: WorkerConfig): BuyerProfileAdapter {
  return config.provider === "mock"
    ? new AwSolutionsAdapter(new MockAwBrowserSession())
    : createRealAdapter(config);
}

export async function runCli(
  argv: string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo = REAL_IO,
): Promise<number> {
  try {
    const args = parseArgs(argv);
    const localSecrets = args.envFile
      ? parseWorkerSecretEnv(await io.readInput(args.envFile))
      : {};
    const config = loadWorkerConfig({
      ...env,
      ...localSecrets,
      ...(args.mode === undefined ? {} : { RECOVERY_MODE: args.mode }),
      ...(args.provider === undefined
        ? {}
        : { RECOVERY_PROVIDER: args.provider }),
    });
    const adapter = createAdapter(config);
    const logger = new JsonLineLogger(io.stderr);
    const input = await io.readInput(args.input);
    const lines = input.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) throw new Error("empty input");

    let exitCode = 0;
    for (const line of lines) {
      const request = RecoveryRequestSchema.parse(JSON.parse(line));
      const report = await runRecovery(request, config, {
        awAdapter: adapter,
        logger,
      });
      io.stdout.write(`${JSON.stringify(report)}\n`);
      if (report.status === "recovery_blocked" || report.status === "failed") {
        exitCode = 2;
      }
    }
    return exitCode;
  } catch {
    io.stderr.write(`${JSON.stringify({ error: "INVALID_INPUT" })}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli(process.argv.slice(2), process.env);
}
