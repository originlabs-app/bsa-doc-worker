import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import { JsonLineLogger, type WorkerLogger } from "../logger.js";
import { createOpenRouterPdfClient } from "../llm/document-reader.js";
import {
  loadReaderConfig,
  ReaderModeSchema,
  type ReaderConfig,
  type ReaderMode,
} from "./config.js";
import type { ReaderPipelineDependencies } from "./pipeline.js";
import { runReaderService, type ReaderServiceReport } from "./service.js";
import { createReaderDocumentSource } from "./source.js";
import {
  createReaderSupabaseClient,
  createSupabaseReaderStore,
} from "./supabase.js";

type ActiveReaderConfig = ReaderConfig & {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  openRouterApiKey: string;
  nukemaUsername: string;
  nukemaPassword: string;
};

type DependencyFactory = (
  config: ActiveReaderConfig,
  logger: WorkerLogger,
  modeSource: () => ReaderMode,
) => ReaderPipelineDependencies;

type ReaderService = typeof runReaderService;

function isActiveConfig(config: ReaderConfig): config is ActiveReaderConfig {
  return Boolean(
    config.supabaseUrl &&
      config.supabaseServiceRoleKey &&
      config.openRouterApiKey &&
      config.nukemaUsername &&
      config.nukemaPassword,
  );
}

function createDependencies(
  config: ActiveReaderConfig,
  logger: WorkerLogger,
  modeSource: () => ReaderMode,
): ReaderPipelineDependencies {
  const client = createReaderSupabaseClient({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
  });
  return {
    store: createSupabaseReaderStore(client),
    source: createReaderDocumentSource({
      supabaseUrl: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
      nukemaUsername: config.nukemaUsername,
      nukemaPassword: config.nukemaPassword,
      maxBytes: config.maxBytes,
    }),
    llmClient: createOpenRouterPdfClient({
      apiKey: config.openRouterApiKey,
      model: config.model,
    }),
    workerId: `railway:${hostname()}:${process.pid}:${randomUUID()}`,
    logger,
    modeSource,
  };
}

function liveMode(
  env: Readonly<Record<string, string | undefined>>,
  fallback: ReaderMode,
): ReaderMode {
  const parsed = ReaderModeSchema.safeParse(env.READER_MODE ?? fallback);
  return parsed.success ? parsed.data : "off";
}

export async function runReaderCli(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    logger?: WorkerLogger;
    dependencyFactory?: DependencyFactory;
    service?: ReaderService;
    signal?: AbortSignal;
    installSignalHandlers?: boolean;
  } = {},
): Promise<number> {
  const logger = options.logger ?? new JsonLineLogger();
  let config: ReaderConfig;
  try {
    config = loadReaderConfig(env);
  } catch {
    logger.info("reader_start_failed", { issue: "READER_CONFIG_INVALID" });
    return 1;
  }

  if (config.mode === "off") {
    logger.info("reader_stopped", { mode: "off", reason: "READER_MODE_OFF" });
    return 0;
  }
  if (!isActiveConfig(config)) {
    logger.info("reader_start_failed", { issue: "READER_CONFIG_INCOMPLETE" });
    return 1;
  }

  const controller = options.signal ? null : new AbortController();
  const signal = options.signal ?? controller?.signal;
  if (!signal) return 1;
  const stop = () => controller?.abort();
  const installSignalHandlers = options.installSignalHandlers ?? true;
  if (installSignalHandlers) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  try {
    const modeSource = () => liveMode(env, config.mode);
    const dependencies = (options.dependencyFactory ?? createDependencies)(
      config,
      logger,
      modeSource,
    );
    logger.info("reader_started", {
      mode: config.mode,
      worker_id: dependencies.workerId,
      batch: config.batch,
      model: config.model,
    });
    const report: ReaderServiceReport = await (options.service ?? runReaderService)(
      config,
      dependencies,
      { signal },
    );
    logger.info("reader_stopped", { ...report, reason: "READER_SERVICE_STOPPED" });
    return 0;
  } catch {
    logger.info("reader_stopped", { issue: "READER_SERVICE_FAILED" });
    return 1;
  } finally {
    if (installSignalHandlers) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runReaderCli(process.env);
}
