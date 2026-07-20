import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  AwAdapterError,
  AwSolutionsAdapter,
} from "./adapters/aw-solutions.js";
import { MockAwBrowserSession } from "./adapters/mock-aw-session.js";
import { MockMaximilienBrowserSession } from "./adapters/mock-maximilien-session.js";
import { MockPlaceBrowserSession } from "./adapters/mock-place-session.js";
import { MaximilienAdapter } from "./adapters/maximilien.js";
import { PlaceAdapter } from "./adapters/place.js";
import { PlaywrightAwBrowserSession } from "./adapters/playwright-aw-session.js";
import { PlaywrightMaximilienBrowserSession } from "./adapters/playwright-maximilien-session.js";
import { PlaywrightPlaceBrowserSession } from "./adapters/playwright-place-session.js";
import { PortalAdapterError } from "./adapters/portal-adapter-error.js";
import {
  BrowserlessUsageClient,
  calculateBrowserlessUsageDelta,
  type BrowserlessUsageReader,
  type BrowserlessUsageSnapshot,
} from "./browserless-usage.js";
import {
  loadWorkerConfig,
  missingRealSecretsForPlatform,
  parseWorkerSecretEnv,
  type WorkerConfig,
} from "./config.js";
import {
  RecoveryRequestSchema,
  type RecoveryRequest,
} from "./contracts.js";
import { JsonLineLogger, type TextOutput } from "./logger.js";
import type { BuyerProfileAdapter } from "./ports.js";
import { routePortal } from "./router.js";
import { runRecovery } from "./worker.js";

export interface CliIo {
  readInput(path: string): Promise<string>;
  stdout: TextOutput;
  stderr: TextOutput;
}

export interface CliAdapters {
  awAdapter: BuyerProfileAdapter;
  placeAdapter: BuyerProfileAdapter;
  maximilienAdapter: BuyerProfileAdapter;
}

export interface CliDependencies {
  adapterFactory?: (config: WorkerConfig) => CliAdapters;
  usageReaderFactory?: (token: string) => BrowserlessUsageReader;
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

function unavailableAwAdapter(): BuyerProfileAdapter {
  return {
    discover: async () => {
      throw new AwAdapterError(
        "MISSING_REAL_SECRETS",
        false,
        "Real AW adapter secrets are unavailable",
      );
    },
  };
}

function unavailablePortalAdapter(): BuyerProfileAdapter {
  return {
    discover: async () => {
      throw new PortalAdapterError(
        "PORTAL_DISCOVERY_BLOCKED",
        false,
        "Real portal adapter secrets are unavailable",
      );
    },
  };
}

function createRealAdapters(config: WorkerConfig): CliAdapters {
  const {
    browserlessToken,
    awPortalEmail,
    awPortalPassword,
    placePortalEmail,
    placePortalPassword,
    maximilienPortalEmail,
    maximilienPortalPassword,
  } = config;

  const awAdapter =
    browserlessToken && awPortalEmail && awPortalPassword
      ? new AwSolutionsAdapter(
          new PlaywrightAwBrowserSession({
            browserlessToken,
            awPortalEmail,
            awPortalPassword,
          }),
        )
      : unavailableAwAdapter();
  const placeAdapter =
    browserlessToken && placePortalEmail && placePortalPassword
      ? new PlaceAdapter(
          new PlaywrightPlaceBrowserSession({
            browserlessToken,
            placePortalEmail,
            placePortalPassword,
          }),
        )
      : unavailablePortalAdapter();
  const maximilienAdapter =
    browserlessToken && maximilienPortalEmail && maximilienPortalPassword
      ? new MaximilienAdapter(
          new PlaywrightMaximilienBrowserSession({
            browserlessToken,
            maximilienPortalEmail,
            maximilienPortalPassword,
          }),
        )
      : unavailablePortalAdapter();

  return { awAdapter, placeAdapter, maximilienAdapter };
}

function createMockAdapters(): CliAdapters {
  return {
    awAdapter: new AwSolutionsAdapter(new MockAwBrowserSession()),
    placeAdapter: new PlaceAdapter(new MockPlaceBrowserSession()),
    maximilienAdapter: new MaximilienAdapter(
      new MockMaximilienBrowserSession(),
    ),
  };
}

function createAdapters(config: WorkerConfig): CliAdapters {
  return config.provider === "mock"
    ? createMockAdapters()
    : createRealAdapters(config);
}

function countMeteredRequests(
  requests: RecoveryRequest[],
  config: WorkerConfig,
): number {
  if (config.mode !== "dry_run" || config.provider !== "real") return 0;
  return requests.filter((request) => {
    const route = routePortal(request.providedUrl);
    return (
      route.disposition === "adapter" &&
      missingRealSecretsForPlatform(config, route.platform).length === 0
    );
  }).length;
}

function createUsageReader(
  token: string,
  dependencies: CliDependencies,
): BrowserlessUsageReader {
  return dependencies.usageReaderFactory?.(token) ??
    new BrowserlessUsageClient(token);
}

export async function runCli(
  argv: string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIo = REAL_IO,
  dependencies: CliDependencies = {},
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
    const logger = new JsonLineLogger(io.stderr);
    const input = await io.readInput(args.input);
    const lines = input.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) throw new Error("empty input");
    const requests = lines.map((line) =>
      RecoveryRequestSchema.parse(JSON.parse(line)),
    );
    const adapters =
      dependencies.adapterFactory?.(config) ?? createAdapters(config);
    const meteredRequestCount = countMeteredRequests(requests, config);
    const usageReader =
      meteredRequestCount > 0 && config.browserlessToken
        ? createUsageReader(config.browserlessToken, dependencies)
        : undefined;
    let usageBefore: BrowserlessUsageSnapshot | undefined;
    if (usageReader) {
      try {
        usageBefore = await usageReader.snapshot();
      } catch {
        logger.info("browserless_usage", {
          status: "unavailable",
          phase: "before_batch",
          scope: "account_batch_delta",
          requestCount: meteredRequestCount,
        });
        return 2;
      }
    }

    let exitCode = 0;
    let processingError: unknown;
    try {
      for (const request of requests) {
        const report = await runRecovery(request, config, {
          ...adapters,
          logger,
        });
        io.stdout.write(`${JSON.stringify(report)}\n`);
        if (
          report.status === "recovery_blocked" ||
          report.status === "failed"
        ) {
          exitCode = 2;
        }
      }
    } catch (error) {
      processingError = error;
    }

    if (usageReader && usageBefore) {
      try {
        const delta = calculateBrowserlessUsageDelta(
          usageBefore,
          await usageReader.snapshot(),
        );
        logger.info("browserless_usage", {
          status: "measured",
          scope: "account_batch_delta",
          requestCount: meteredRequestCount,
          ...delta,
        });
      } catch {
        logger.info("browserless_usage", {
          status: "unavailable",
          phase: "after_batch",
          scope: "account_batch_delta",
          requestCount: meteredRequestCount,
        });
        exitCode = 2;
      }
    }
    if (processingError) throw processingError;
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
