import { pathToFileURL } from "node:url";

import { AwSolutionsAdapter } from "../adapters/aw-solutions.js";
import { MaximilienAdapter } from "../adapters/maximilien.js";
import { PlaceAdapter } from "../adapters/place.js";
import {
  AwCaptchaSolveBudget,
  PlaywrightAwBrowserSession,
} from "../adapters/playwright-aw-session.js";
import { PlaywrightMaximilienBrowserSession } from "../adapters/playwright-maximilien-session.js";
import { PlaywrightPlaceBrowserSession } from "../adapters/playwright-place-session.js";
import { JsonLineLogger, type WorkerLogger } from "../logger.js";
import type { BuyerProfileAdapter } from "../ports.js";
import {
  isParisCronWindow,
  loadRecoveryConfig,
  type RecoveryConfig,
} from "./config.js";
import type { RecoveryPortal } from "./contracts.js";
import { createRecoveryDocumentPipeline } from "./pipeline.js";
import { createRecoveryPortalSearcher } from "./search.js";
import {
  runRecoverySweep,
  type RecoverySweepDependencies,
  type RecoverySweepReport,
} from "./service.js";
import { createSupabaseRecoveryStorage } from "./storage.js";
import {
  createRecoverySupabaseClient,
  createSupabaseRecoveryStore,
} from "./supabase.js";

interface ActiveRecoveryConfig extends RecoveryConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  browserlessToken: string | undefined;
  awPortalEmail: string | undefined;
  awPortalPassword: string | undefined;
  placePortalEmail: string | undefined;
  placePortalPassword: string | undefined;
  maximilienPortalEmail: string | undefined;
  maximilienPortalPassword: string | undefined;
}

export type RecoveryDependencyFactory = (
  config: ActiveRecoveryConfig,
  logger: WorkerLogger,
) => RecoverySweepDependencies;

export type RecoveryRunner = (
  config: RecoveryConfig,
  dependencies: RecoverySweepDependencies,
) => Promise<RecoverySweepReport>;

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function safeSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function activeConfig(
  config: RecoveryConfig,
  env: Readonly<Record<string, string | undefined>>,
): ActiveRecoveryConfig | null {
  const supabaseUrl = nonEmpty(env.SUPABASE_URL);
  const supabaseServiceRoleKey = nonEmpty(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !safeSupabaseUrl(supabaseUrl) || !supabaseServiceRoleKey) {
    return null;
  }
  const portalSecrets = {
    browserlessToken: nonEmpty(env.BROWSERLESS_TOKEN),
    awPortalEmail: nonEmpty(env.AW_PORTAL_EMAIL),
    awPortalPassword: nonEmpty(env.AW_PORTAL_PASSWORD),
    placePortalEmail: nonEmpty(env.PLACE_PORTAL_EMAIL),
    placePortalPassword: nonEmpty(env.PLACE_PORTAL_PASSWORD),
    maximilienPortalEmail: nonEmpty(env.MAXIMILIEN_PORTAL_EMAIL),
    maximilienPortalPassword: nonEmpty(env.MAXIMILIEN_PORTAL_PASSWORD),
  };
  if (
    config.mode === "apply" &&
    Object.values(portalSecrets).some((value) => value === undefined)
  ) {
    return null;
  }
  return {
    ...config,
    supabaseUrl,
    supabaseServiceRoleKey,
    ...portalSecrets,
  };
}

function adapterFor(
  adapters: Readonly<Record<RecoveryPortal, BuyerProfileAdapter>>,
  portal: RecoveryPortal,
): BuyerProfileAdapter {
  return adapters[portal];
}

function createDependencies(
  config: ActiveRecoveryConfig,
  logger: WorkerLogger,
): RecoverySweepDependencies {
  const client = createRecoverySupabaseClient({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
  });
  const store = createSupabaseRecoveryStore(client);
  const searchPortal = createRecoveryPortalSearcher();
  if (config.mode !== "apply") {
    return {
      store,
      searchPortal,
      discover: async () => {
        throw new Error("RECOVERY_DRY_RUN_DISCOVERY_FORBIDDEN");
      },
      pipeline: {
        fetchAndUpload: async () => {
          throw new Error("RECOVERY_DRY_RUN_SINK_FORBIDDEN");
        },
      },
      logger,
    };
  }

  const browserlessToken = config.browserlessToken!;
  const captchaBudget = new AwCaptchaSolveBudget();
  const adapters: Record<RecoveryPortal, BuyerProfileAdapter> = {
    aw_solutions: new AwSolutionsAdapter(
      new PlaywrightAwBrowserSession({
        browserlessToken,
        awPortalEmail: config.awPortalEmail!,
        awPortalPassword: config.awPortalPassword!,
        captchaBudget,
        logger,
      }),
    ),
    place: new PlaceAdapter(
      new PlaywrightPlaceBrowserSession({
        browserlessToken,
        placePortalEmail: config.placePortalEmail!,
        placePortalPassword: config.placePortalPassword!,
        solveCaptchas: false,
      }),
    ),
    maximilien: new MaximilienAdapter(
      new PlaywrightMaximilienBrowserSession({
        browserlessToken,
        maximilienPortalEmail: config.maximilienPortalEmail!,
        maximilienPortalPassword: config.maximilienPortalPassword!,
        solveCaptchas: false,
      }),
    ),
  };
  return {
    store,
    searchPortal,
    discover: (portal, request) => adapterFor(adapters, portal).discover(request),
    pipeline: createRecoveryDocumentPipeline({
      storage: createSupabaseRecoveryStorage({
        supabaseUrl: config.supabaseUrl,
        serviceRoleKey: config.supabaseServiceRoleKey,
      }),
      maxBytes: config.maxBytes,
      logger,
    }),
    captchaUnits: () => captchaBudget.unitsCommitted,
    logger,
  };
}

export async function runRecoveryCli(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    scheduled?: boolean;
    now?: () => Date;
    logger?: WorkerLogger;
    dependencyFactory?: RecoveryDependencyFactory;
    runner?: RecoveryRunner;
  } = {},
): Promise<number> {
  const logger = options.logger ?? new JsonLineLogger();
  let config: RecoveryConfig;
  try {
    config = loadRecoveryConfig(env);
  } catch {
    logger.info("recovery_start_failed", { issue: "RECOVERY_CONFIG_INVALID" });
    return 1;
  }

  const now = (options.now ?? (() => new Date()))();
  if (options.scheduled && !isParisCronWindow(now)) {
    logger.info("recovery_skipped_wrong_hour", {
      timezone: "Europe/Paris",
      scheduled: true,
    });
    return 0;
  }
  if (config.mode === "off") {
    logger.info("recovery_stopped", { mode: "off", reason: "RECOVERY_MODE_OFF" });
    return 0;
  }
  const active = activeConfig(config, env);
  if (!active) {
    logger.info("recovery_start_failed", { issue: "RECOVERY_CONFIG_INCOMPLETE" });
    return 1;
  }

  try {
    const dependencies = (options.dependencyFactory ?? createDependencies)(
      active,
      logger,
    );
    logger.info("recovery_started", {
      mode: active.mode,
      one_shot: true,
      scheduled: options.scheduled ?? false,
      release: env.WORKER_RELEASE_SHA ?? "unknown",
    });
    const report = await (options.runner ?? runRecoverySweep)(active, dependencies);
    logger.info("recovery_stopped", {
      mode: report.mode,
      n_eligible: report.nEligible,
      n_found: report.nFound,
      n_ambiguous: report.nAmbiguous,
      n_blocked: report.nBlocked,
      n_not_found: report.nNotFound,
      n_too_large: report.nTooLarge,
      n_error: report.nError,
    });
    return 0;
  } catch {
    logger.info("recovery_stopped", { issue: "RECOVERY_SERVICE_FAILED" });
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--scheduled")) {
    process.exitCode = 1;
  } else {
    process.exitCode = await runRecoveryCli(process.env, {
      scheduled: args.includes("--scheduled"),
    });
  }
}
