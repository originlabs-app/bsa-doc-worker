import { AwAdapterError } from "./adapters/aw-solutions.js";
import type { WorkerConfig } from "./config.js";
import type { RecoveryReport, RecoveryRequest } from "./contracts.js";
import type { WorkerLogger } from "./logger.js";
import type { BuyerProfileAdapter } from "./ports.js";
import { routePortal } from "./router.js";

const MAX_ATTEMPTS_PER_TENDER = 2;
const RECOVERY_BLOCKING_REASONS = new Set([
  "AW_AUTHENTICATION_REJECTED",
  "CAPTCHA_UNSOLVED",
  "PROFILE_LINK_NOT_FINAL",
  "RETRY_CAP_REACHED",
]);

export interface RecoveryDependencies {
  awAdapter: BuyerProfileAdapter;
  logger?: WorkerLogger;
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

  if (route.disposition === "publication_only") {
    return finish({
      ...baseReport(request, config, route.platform, 0),
      status: "publication_only",
      reasonCode: route.reasonCode,
    });
  }

  if (route.disposition === "blocked") {
    return finish({
      ...baseReport(request, config, route.platform, 0),
      status: "recovery_blocked",
      reasonCode: route.reasonCode,
    });
  }

  if (config.provider === "real" && config.missingRealSecrets.length > 0) {
    return finish({
      ...baseReport(request, config, route.platform, 0),
      status: "recovery_blocked",
      reasonCode: "MISSING_REAL_SECRETS",
    });
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TENDER; attempt += 1) {
    try {
      const discovery = await dependencies.awAdapter.discover(request);
      return finish({
        ...baseReport(request, config, route.platform, attempt),
        status: "manifest_ready",
        manifest: discovery.safeManifest,
      });
    } catch (error) {
      const adapterError =
        error instanceof AwAdapterError
          ? error
          : new AwAdapterError("ADAPTER_FAILURE", false, "Adapter failure");
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
