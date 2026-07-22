import type { AdapterDiscovery } from "../ports.js";
import type { RecoveryMode, RecoveryRequest } from "../contracts.js";
import type { WorkerLogger } from "../logger.js";
import {
  RECOVERY_PORTALS,
  RecoveryTooLargeError,
  type RecoveryFailure,
  type MatchEvidence,
  type PortalSearchResult,
  type RecoveryAttemptStatus,
  type RecoveryAttemptStore,
  type RecoveryDecision,
  type RecoveryDocumentPipeline,
  type RecoveryPortal,
  type RecoveryTarget,
} from "./contracts.js";
import { toRecoveryFailure } from "./failure.js";
import { reconcilePortalCandidates } from "./matching.js";

export interface RecoverySweepConfig {
  mode: RecoveryMode;
  batchSize: number;
}

export interface RecoverySweepDependencies {
  store: RecoveryAttemptStore;
  searchPortal(
    portal: RecoveryPortal,
    target: RecoveryTarget,
  ): Promise<PortalSearchResult>;
  discover(
    portal: RecoveryPortal,
    request: RecoveryRequest,
  ): Promise<AdapterDiscovery>;
  pipeline: RecoveryDocumentPipeline;
  captchaUnits?(): number;
  logger?: WorkerLogger;
}

export interface RecoverySweepReport {
  mode: RecoveryMode;
  nEligible: number;
  nFound: number;
  nAmbiguous: number;
  nBlocked: number;
  nNotFound: number;
  nTooLarge: number;
  nError: number;
}

function emptyReport(mode: RecoveryMode): RecoverySweepReport {
  return {
    mode,
    nEligible: 0,
    nFound: 0,
    nAmbiguous: 0,
    nBlocked: 0,
    nNotFound: 0,
    nTooLarge: 0,
    nError: 0,
  };
}

function safeEvidence(
  searchResults: readonly PortalSearchResult[],
  matches: readonly MatchEvidence[],
): Record<string, unknown> {
  return {
    portals: searchResults.map((result) => ({
      portal: result.portal,
      error_code: result.errorCode ?? null,
      blocked_external_host: result.blockedExternalHost ?? null,
      request_count: result.requestCount ?? null,
      ...(result.failure ? { failure: result.failure } : {}),
      candidates: result.candidates.map((candidate) => ({
        title: candidate.canonicalTitle,
        reference: candidate.reference,
        buyer_name: candidate.buyerName,
        consultation_url: candidate.consultationUrl,
        deadline_at: candidate.deadlineAt ?? null,
        lot_titles: candidate.lotTitles ?? [],
        recovery_disposition: candidate.recoveryDisposition ?? "recoverable",
        blocked_external_host: candidate.blockedExternalHost ?? null,
      })),
    })),
    matches: matches.map((match) => ({
      portal: match.candidate.portal,
      decision: match.level,
      title: match.candidate.canonicalTitle,
      reference: match.candidate.reference,
      buyer_name: match.candidate.buyerName,
      consultation_url: match.candidate.consultationUrl,
      reference_exact: match.referenceExact,
      buyer_exact: match.buyerExact,
      buyer_matched: match.buyerMatched,
      buyer_token_overlap: Number(match.buyerTokenOverlap.toFixed(4)),
      buyer_shared_tokens: match.buyerSharedTokens,
      title_matched: match.titleMatched,
      title_prefix_match: match.titlePrefixMatch,
      title_jaccard: Number(match.titleJaccard.toFixed(4)),
      lot_token_hits: match.lotTokenHits,
      lot_title_matches: match.lotTitleMatches,
      deadline_status: match.deadlineStatus,
      place_umbrella_compatible: match.placeUmbrellaCompatible,
    })),
  };
}

function originalPortalBlocked(link: string): boolean {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return host === "achatpublic.com" || host.endsWith(".achatpublic.com");
  } catch {
    return false;
  }
}

function requestFor(target: RecoveryTarget, match: MatchEvidence): RecoveryRequest {
  return {
    jobId: `recovery-${target.tenderId}`,
    tenderId: target.tenderId,
    sourceField: "url_consultation",
    providedUrl: match.candidate.consultationUrl,
    requestedLots: { kind: "all" },
    searchHints: {
      reference: target.reference,
      title: target.title,
      buyerName: target.buyerName,
    },
  };
}

function increment(report: RecoverySweepReport, status: RecoveryAttemptStatus): void {
  if (status === "found") report.nFound += 1;
  else if (status === "ambiguous") report.nAmbiguous += 1;
  else if (status === "blocked") report.nBlocked += 1;
  else if (status === "not_found") report.nNotFound += 1;
  else if (status === "too_large") report.nTooLarge += 1;
  else report.nError += 1;
}

function errorReason(error: unknown): "blocked" | "error" {
  if (!error || typeof error !== "object" || !("reasonCode" in error)) {
    return "error";
  }
  const reason = String(error.reasonCode);
  return /BLOCKED|CAPTCHA|AUTHENTICATION|PROFILE_LINK/.test(reason)
    ? "blocked"
    : "error";
}

function unitsNow(dependencies: RecoverySweepDependencies): number {
  return dependencies.captchaUnits?.() ?? 0;
}

function withAttemptUnits(
  failure: RecoveryFailure,
  dependencies: RecoverySweepDependencies,
  unitsAtStart: number,
): RecoveryFailure {
  return {
    ...failure,
    units_spent: Math.max(0, unitsNow(dependencies) - unitsAtStart),
  };
}

function logAttemptCompleted(
  dependencies: RecoverySweepDependencies,
  input: {
    tenderId: string;
    portal: RecoveryPortal | null;
    decision: RecoveryDecision | "blocked" | "error";
    status: RecoveryAttemptStatus;
    unitsAtStart: number;
    failure?: RecoveryFailure;
  },
): void {
  const units = unitsNow(dependencies);
  dependencies.logger?.info("recovery_attempt_completed", {
    tender_id: input.tenderId,
    portal: input.portal,
    decision: input.decision,
    status: input.status,
    units,
    units_spent: Math.max(0, units - input.unitsAtStart),
    ...(input.failure
      ? {
          issue: input.failure.reason_code ?? input.failure.type,
          reason_code: input.failure.reason_code,
          failure_message: input.failure.message,
          failure: input.failure,
        }
      : {}),
  });
}

function externalPortalFailure(
  host: string,
  unitsSpent: number,
): RecoveryFailure {
  return toRecoveryFailure(null, {
    stage: "identification",
    type: "external_portal",
    reasonCode: "UNSUPPORTED_PORTAL",
    retryable: false,
    message: `Buyer profile resolves to unsupported host ${host}`,
    unitsSpent,
  });
}

async function finalize(
  store: RecoveryAttemptStore,
  attemptId: string,
  status: Exclude<RecoveryAttemptStatus, "found">,
  portal: RecoveryPortal | null,
  decision: RecoveryDecision | "blocked" | "error",
  evidence: Record<string, unknown>,
): Promise<void> {
  await store.finalize({ attemptId, status, portal, decision, evidence });
}

export async function runRecoverySweep(
  config: RecoverySweepConfig,
  dependencies: RecoverySweepDependencies,
): Promise<RecoverySweepReport> {
  const report = emptyReport(config.mode);
  if (config.mode === "off") return report;

  if (config.mode === "apply") {
    await dependencies.store.validateApplyReadiness();
  }

  const targets = await dependencies.store.listEligible(config.batchSize);
  report.nEligible = targets.length;
  dependencies.logger?.info("recovery_selection_completed", {
    mode: config.mode,
    n_eligible: targets.length,
    units: 0,
  });

  for (const target of targets) {
    const reservation =
      config.mode === "apply"
        ? await dependencies.store.reserve(target.tenderId)
        : null;
    if (config.mode === "apply" && reservation === null) continue;
    const unitsAtStart = unitsNow(dependencies);

    let searchResults: PortalSearchResult[];
    try {
      searchResults = await Promise.all(
        RECOVERY_PORTALS.map(async (portal) => {
          try {
            return await dependencies.searchPortal(portal, target);
          } catch (error) {
            return {
              portal,
              candidates: [],
              errorCode: "PORTAL_SEARCH_FAILED",
              failure: toRecoveryFailure(error, {
                stage: "identification",
                type: "network",
                reasonCode: "PORTAL_SEARCH_FAILED",
                retryable: true,
                unitsSpent: 0,
              }),
            };
          }
        }),
      );
    } catch (error) {
      searchResults = RECOVERY_PORTALS.map((portal) => ({
        portal,
        candidates: [],
        errorCode: "PORTAL_SEARCH_FAILED",
        failure: toRecoveryFailure(error, {
          stage: "identification",
          type: "network",
          reasonCode: "PORTAL_SEARCH_FAILED",
          retryable: true,
          unitsSpent: 0,
        }),
      }));
    }

    const reconciliation = reconcilePortalCandidates(
      target,
      searchResults.flatMap(({ candidates }) => candidates),
    );
    const evidence = safeEvidence(searchResults, reconciliation.evidence);
    for (const searchResult of searchResults) {
      const portalMatch = reconciliation.evidence.find(
        ({ candidate }) => candidate.portal === searchResult.portal,
      );
      dependencies.logger?.info("recovery_identification_completed", {
        tender_id: target.tenderId,
        portal: searchResult.portal,
        decision: portalMatch?.level ??
          (searchResult.errorCode ? "error" : "low"),
        candidates: searchResult.candidates.length,
        units: 0,
      });
    }

    if (reconciliation.outcome !== "matched") {
      let status: "ambiguous" | "blocked" | "not_found" | "error";
      if (reconciliation.outcome === "ambiguous") status = "ambiguous";
      else if (
        searchResults.some(({ errorCode }) => errorCode) &&
        searchResults.every(({ candidates }) => candidates.length === 0)
      ) status = "error";
      else if (
        searchResults.some(({ blockedExternalHost }) => blockedExternalHost) ||
        originalPortalBlocked(target.buyerProfileLink)
      ) status = "blocked";
      else status = "not_found";
      increment(report, status);
      const blockedHost = searchResults.find(
        ({ blockedExternalHost }) => blockedExternalHost,
      )?.blockedExternalHost;
      const baseFailure = status === "error"
        ? searchResults.find(({ failure }) => failure)?.failure ??
          toRecoveryFailure(null, {
            stage: "identification",
            type: "network",
            reasonCode: "PORTAL_SEARCH_FAILED",
            retryable: true,
            message: "All portal searches failed",
            unitsSpent: 0,
          })
        : status === "blocked"
          ? externalPortalFailure(
              blockedHost ?? new URL(target.buyerProfileLink).hostname,
              0,
            )
          : undefined;
      const failure = baseFailure
        ? withAttemptUnits(baseFailure, dependencies, unitsAtStart)
        : undefined;
      if (reservation) {
        const decision = status === "ambiguous"
          ? "medium"
          : status === "blocked"
            ? "blocked"
            : status === "error"
              ? "error"
              : "low";
        await finalize(
          dependencies.store,
          reservation.attemptId,
          status,
          null,
          decision,
          failure ? { ...evidence, failure } : evidence,
        );
        logAttemptCompleted(dependencies, {
          tenderId: target.tenderId,
          portal: null,
          decision,
          status,
          unitsAtStart,
          ...(failure ? { failure } : {}),
        });
      }
      continue;
    }

    if (reconciliation.match.candidate.recoveryDisposition === "external_blocked") {
      increment(report, "blocked");
      if (reservation) {
        const failure = externalPortalFailure(
          reconciliation.match.candidate.blockedExternalHost ??
            new URL(reconciliation.match.candidate.consultationUrl).hostname,
          0,
        );
        await finalize(
          dependencies.store,
          reservation.attemptId,
          "blocked",
          reconciliation.match.candidate.portal,
          reconciliation.match.level,
          { ...evidence, failure },
        );
        logAttemptCompleted(dependencies, {
          tenderId: target.tenderId,
          portal: reconciliation.match.candidate.portal,
          decision: reconciliation.match.level,
          status: "blocked",
          unitsAtStart,
          failure,
        });
      }
      continue;
    }

    if (config.mode === "dry_run") {
      increment(report, "found");
      continue;
    }
    if (!reservation) continue;

    const { match } = reconciliation;
    let failureStage: "manifest" | "download" | "persistence" = "manifest";
    try {
      const discovery = await dependencies.discover(
        match.candidate.portal,
        requestFor(target, match),
      );
      dependencies.logger?.info("recovery_manifest_discovered", {
        tender_id: target.tenderId,
        portal: match.candidate.portal,
        decision: match.level,
        attachments: discovery.safeManifest.attachments.length,
        units: dependencies.captchaUnits?.() ?? 0,
      });
      failureStage = "download";
      const prepared = await dependencies.pipeline.fetchAndUpload({
        target,
        match,
        discovery,
      });
      try {
        failureStage = "persistence";
        const persisted = await dependencies.store.persistFound({
          attemptId: reservation.attemptId,
          tenderId: target.tenderId,
          portal: match.candidate.portal,
          decision: match.level,
          evidence: {
            ...evidence,
            manifest: prepared.documents.map((document) => ({
              file_name: document.fileName,
              bytes: document.bytes,
              sha256: document.sha256,
              storage_path: document.objectPath,
              source_reference: document.sourceReference,
            })),
          },
          documents: prepared.documents,
        });
        dependencies.logger?.info("recovery_sink_completed", {
          tender_id: target.tenderId,
          portal: match.candidate.portal,
          decision: match.level,
          bytes: prepared.documents.reduce(
            (sum, document) => sum + document.bytes,
            0,
          ),
          inserted_documents: persisted.insertedDocuments,
          queue_status: persisted.queueStatus,
          units: dependencies.captchaUnits?.() ?? 0,
        });
        logAttemptCompleted(dependencies, {
          tenderId: target.tenderId,
          portal: match.candidate.portal,
          decision: match.level,
          status: "found",
          unitsAtStart,
        });
      } catch (error) {
        await prepared.rollback().catch(() => undefined);
        throw error;
      } finally {
        await prepared.dispose().catch(() => undefined);
      }
      increment(report, "found");
    } catch (error) {
      const status = error instanceof RecoveryTooLargeError
        ? "too_large"
        : errorReason(error);
      const failure = toRecoveryFailure(error, {
        stage: failureStage,
        unitsSpent: Math.max(0, unitsNow(dependencies) - unitsAtStart),
      });
      increment(report, status);
      await finalize(
        dependencies.store,
        reservation.attemptId,
        status,
        match.candidate.portal,
        status === "too_large" ? match.level : status,
        { ...evidence, failure },
      );
      logAttemptCompleted(dependencies, {
        tenderId: target.tenderId,
        portal: match.candidate.portal,
        decision: status === "too_large" ? match.level : status,
        status,
        unitsAtStart,
        failure,
      });
    }
  }

  dependencies.logger?.info("recovery_run_summary", {
    mode: report.mode,
    n_eligible: report.nEligible,
    n_found: report.nFound,
    n_ambiguous: report.nAmbiguous,
    n_blocked: report.nBlocked,
    n_not_found: report.nNotFound,
    n_too_large: report.nTooLarge,
    n_error: report.nError,
  });
  return report;
}
