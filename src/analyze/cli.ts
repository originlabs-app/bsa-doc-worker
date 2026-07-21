import { pathToFileURL } from "node:url";

import { JsonLineLogger, type WorkerLogger } from "../logger.js";
import type { AnalyzeConfig } from "./config.js";
import { loadAnalyzeConfig } from "./config.js";
import {
  buildAnalyzeLearningSnapshot,
  createSupabaseLearningMemoryStore,
  embedText,
  type SupabaseLearningClient,
} from "./learning.js";
import { createOpenRouterDceAnalystClient } from "./sdk-client.js";
import {
  createAnalyzeSupabaseClient,
  createSupabaseAnalyzeStore,
} from "./supabase.js";
import {
  runAnalyzeOneShot,
  type AnalyzeOneShotDependencies,
  type AnalyzeOneShotReport,
} from "./wiring.js";

type ActiveAnalyzeConfig = AnalyzeConfig & {
  openRouterApiKey: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
};

export type AnalyzeDependencyFactory = (
  config: ActiveAnalyzeConfig,
  logger: WorkerLogger,
) => AnalyzeOneShotDependencies;

export type AnalyzeRunner = (
  config: AnalyzeConfig,
  dependencies: AnalyzeOneShotDependencies,
) => Promise<AnalyzeOneShotReport>;

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function safeSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function activeConfig(
  config: AnalyzeConfig,
  env: Readonly<Record<string, string | undefined>>,
): ActiveAnalyzeConfig | null {
  const supabaseUrl = nonEmpty(env.SUPABASE_URL);
  const supabaseServiceRoleKey = nonEmpty(env.SUPABASE_SERVICE_ROLE_KEY);
  if (
    !config.openRouterApiKey ||
    !supabaseUrl ||
    !safeSupabaseUrl(supabaseUrl) ||
    !supabaseServiceRoleKey
  ) {
    return null;
  }
  return {
    ...config,
    openRouterApiKey: config.openRouterApiKey,
    supabaseUrl,
    supabaseServiceRoleKey,
  };
}

function createDependencies(
  config: ActiveAnalyzeConfig,
  logger: WorkerLogger,
): AnalyzeOneShotDependencies {
  const supabase = createAnalyzeSupabaseClient({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
  });
  const store = createSupabaseAnalyzeStore(supabase, {
    recordTypes: config.recordTypes,
  });
  const learningStore = createSupabaseLearningMemoryStore(
    supabase as unknown as SupabaseLearningClient,
  );
  const base = {
    readStore: store,
    client: createOpenRouterDceAnalystClient({
      apiKey: config.openRouterApiKey,
      model: config.model,
    }),
    recallLearning: (assembly: Parameters<
      AnalyzeOneShotDependencies["recallLearning"]
    >[0]) => buildAnalyzeLearningSnapshot({
      enabled: true,
      companyId: assembly.companyId,
      tender: assembly.dossier.tender,
      store: learningStore,
      embed: (text) => embedText(text, config.openRouterApiKey),
    }),
    logger,
  } satisfies AnalyzeOneShotDependencies;

  if (config.mode !== "apply") return base;
  return {
    ...base,
    applyStore: store,
    recordLearningUsage: (ruleIds) => learningStore.recordRuleUsage(ruleIds),
  };
}

function reportLogFields(report: AnalyzeOneShotReport): Record<string, unknown> {
  if (report.status === "off" || report.status === "empty") {
    return report;
  }
  if (report.status !== "analyzed") {
    return {
      mode: report.mode,
      status: report.status,
      queue_id: report.queueId,
      tender_id: report.tenderId,
      issue: report.issue,
    };
  }
  return {
    mode: report.mode,
    status: report.status,
    queue_id: report.queueId,
    tender_id: report.tenderId,
    existing_score: report.existingScore,
    analyzed_score: report.analyzedScore,
    delta: report.delta,
  };
}

export async function runAnalyzeCli(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    logger?: WorkerLogger;
    dependencyFactory?: AnalyzeDependencyFactory;
    runner?: AnalyzeRunner;
  } = {},
): Promise<number> {
  const logger = options.logger ?? new JsonLineLogger();
  let config: AnalyzeConfig;
  try {
    config = loadAnalyzeConfig(env);
  } catch {
    logger.info("analyze_start_failed", { issue: "ANALYZE_CONFIG_INVALID" });
    return 1;
  }

  if (config.mode === "off") {
    logger.info("analyze_stopped", {
      mode: "off",
      reason: "ANALYZE_MODE_OFF",
    });
    return 0;
  }
  const active = activeConfig(config, env);
  if (!active) {
    logger.info("analyze_start_failed", { issue: "ANALYZE_CONFIG_INCOMPLETE" });
    return 1;
  }

  try {
    const dependencies = (options.dependencyFactory ?? createDependencies)(
      active,
      logger,
    );
    logger.info("analyze_started", {
      mode: active.mode,
      model: active.model,
      record_types: active.recordTypes,
      one_shot: true,
    });
    const report = await (options.runner ?? runAnalyzeOneShot)(active, dependencies);
    logger.info("analyze_stopped", reportLogFields(report));
    return report.status === "failed" ? 1 : 0;
  } catch {
    logger.info("analyze_stopped", { issue: "ANALYZE_SERVICE_FAILED" });
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runAnalyzeCli(process.env);
}
