import { AwAdapterError } from "./adapters/aw-solutions.js";
import { PortalAdapterError } from "./adapters/portal-adapter-error.js";
import {
  missingRealSecretsForPlatform,
  type WorkerConfig,
} from "./config.js";
import type { RecoveryReport, RecoveryRequest } from "./contracts.js";
import type { WorkerLogger } from "./logger.js";
import type { BuyerProfileAdapter } from "./ports.js";
import { routePortal } from "./router.js";

const MAX_ATTEMPTS_PER_TENDER = 2;
const RECOVERY_BLOCKING_REASONS = new Set([
  "AW_AUTHENTICATION_REJECTED",
  "CAPTCHA_UNSOLVED",
  "PORTAL_AUTHENTICATION_REJECTED",
  "PORTAL_DISCOVERY_BLOCKED",
  "PROFILE_LINK_NOT_FINAL",
  "RETRY_CAP_REACHED",
]);

export interface RecoveryDependencies {
  awAdapter: BuyerProfileAdapter;
  placeAdapter?: BuyerProfileAdapter;
  maximilienAdapter?: BuyerProfileAdapter;
  logger?: WorkerLogger;
}

function adapterForRoute(
  platform: "aw_solutions" | "place" | "maximilien",
  dependencies: RecoveryDependencies,
): BuyerProfileAdapter | undefined {
  if (platform === "aw_solutions") return dependencies.awAdapter;
  if (platform === "place") return dependencies.placeAdapter;
  return dependencies.maximilienAdapter;
}

function baseReport(
  request: RecoveryRequest,
  config: WorkerConfig,
  platform: RecoveryReport["platform"],
  attemptsUsed: number,
): Pick<
  RecoveryReport,
  | "jobId"
  | "tenderId"
  | "mode"
  | "platform"
  | "attemptsUsed"
  | "productionWriteOccurred"
> {
  return {
    jobId: request.jobId,
    tenderId: request.tenderId,
    mode: config.mode,
    platform,
    attemptsUsed,
    productionWriteOccurred: false,
  };
}

function logReport(
  report: RecoveryReport,
  request: RecoveryRequest,
  logger: WorkerLogger | undefined,
): RecoveryReport {
  logger?.info("recovery_finished", {
    jobId: report.jobId,
    tenderId: report.tenderId,
    sourceHost: new URL(request.providedUrl).hostname,
    mode: report.mode,
    platform: report.platform,
    status: report.status,
    reasonCode: report.reasonCode,
    attemptsUsed: report.attemptsUsed,
    attachmentCount: report.manifest?.attachments.length ?? 0,
    productionWriteOccurred: false,
  });
  return report;
}

export async function runRecovery(
  request: RecoveryRequest,
  config: WorkerConfig,
  dependencies: RecoveryDependencies,
): Promise<RecoveryReport> {
  const route = routePortal(request.providedUrl);
  const finish = (report: RecoveryReport) =>
    logReport(report, request, dependencies.logger);

  if (config.mode === "off") {
    return finish({
      ...baseReport(request, config, route.platform, 0),
      status: "off",
      reasonCode: "WORKER_OFF",
    });
  }

  if (config.mode === "apply") {
    return finish({
      ...baseReport(request, config, route.platform, 0),
      status: "recovery_blocked",
      reasonCode: "APPLY_NOT_AUTHORIZED",
    });
  }

  if (route.disposition !== "adapter") {
    return finish({
      ...baseReport(request, config, route.platform, 0),
      status:
        route.disposition === "publication_only"
          ? "publication_only"
          : "recovery_blocked",
      reasonCode: route.reasonCode,
    });
  }

  if (
    missingRealSecretsForPlatform(config, route.platform).length > 0
  ) {
    return finish({
      ...baseReport(request, config, route.platform, 0),
      status: "recovery_blocked",
      reasonCode: "MISSING_REAL_SECRETS",
    });
  }

  const adapter = adapterForRoute(route.platform, dependencies);
  if (!adapter) {
    return finish({
      ...baseReport(request, config, route.platform, 0),
      status: "recovery_blocked",
      reasonCode: "PORTAL_DISCOVERY_BLOCKED",
    });
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TENDER; attempt += 1) {
    try {
      const discovery = await adapter.discover(request);
      return finish({
        ...baseReport(request, config, route.platform, attempt),
        status: "manifest_ready",
        manifest: discovery.safeManifest,
      });
    } catch (error) {
      const adapterError =
        error instanceof AwAdapterError || error instanceof PortalAdapterError
          ? error
          : route.platform === "aw_solutions"
            ? new AwAdapterError("ADAPTER_FAILURE", false, "Adapter failure")
            : new PortalAdapterError(
                "PORTAL_DISCOVERY_BLOCKED",
                true,
                "Portal adapter failure",
              );
      if (adapterError.retryable && attempt < MAX_ATTEMPTS_PER_TENDER) {
        continue;
      }
      const reasonCode =
        adapterError.retryable && attempt === MAX_ATTEMPTS_PER_TENDER
          ? "RETRY_CAP_REACHED"
          : adapterError.reasonCode;
      return finish({
        ...baseReport(request, config, route.platform, attempt),
        status: RECOVERY_BLOCKING_REASONS.has(reasonCode)
          ? "recovery_blocked"
          : "failed",
        reasonCode,
      });
    }
  }

  throw new Error("unreachable recovery loop");
}
