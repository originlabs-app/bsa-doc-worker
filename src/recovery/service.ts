import type { AdapterDiscovery } from "../ports.js";
import type { RecoveryMode, RecoveryRequest } from "../contracts.js";
import type { WorkerLogger } from "../logger.js";
import {
  RECOVERY_PORTALS,
  RecoveryTooLargeError,
  type MatchEvidence,
  type PortalSearchResult,
  type RecoveryAttemptStatus,
  type RecoveryAttemptStore,
  type RecoveryDecision,
  type RecoveryDocumentPipeline,
  type RecoveryPortal,
  type RecoveryTarget,
} from "./contracts.js";
import { reconcilePortalCandidates } from "./matching.js";

export interface RecoverySweepConfig {
  mode: RecoveryMode;
  batchSize: number;
  strongTitleJaccard?: number;
  titleOnlyJaccard?: number;
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
      candidates: result.candidates.map((candidate) => ({
        title: candidate.canonicalTitle,
        reference: candidate.reference,
        buyer_name: candidate.buyerName,
        consultation_url: candidate.consultationUrl,
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
      title_jaccard: Number(match.titleJaccard.toFixed(4)),
      lot_token_hits: match.lotTokenHits,
      lot_title_matches: match.lotTitleMatches,
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

  for (const target of targets) {
    const reservation =
      config.mode === "apply"
        ? await dependencies.store.reserve(target.tenderId)
        : null;
    if (config.mode === "apply" && reservation === null) continue;

    let searchResults: PortalSearchResult[];
    try {
      searchResults = await Promise.all(
        RECOVERY_PORTALS.map((portal) =>
          dependencies.searchPortal(portal, target).catch(() => ({
            portal,
            candidates: [],
            errorCode: "PORTAL_SEARCH_FAILED",
          })),
        ),
      );
    } catch {
      searchResults = RECOVERY_PORTALS.map((portal) => ({
        portal,
        candidates: [],
        errorCode: "PORTAL_SEARCH_FAILED",
      }));
    }

    const reconciliation = reconcilePortalCandidates(
      target,
      searchResults.flatMap(({ candidates }) => candidates),
      {
        ...(config.strongTitleJaccard === undefined
          ? {}
          : { strong: config.strongTitleJaccard }),
        ...(config.titleOnlyJaccard === undefined
          ? {}
          : { titleOnly: config.titleOnlyJaccard }),
      },
    );
    const evidence = safeEvidence(searchResults, reconciliation.evidence);

    if (reconciliation.outcome !== "matched") {
      let status: "ambiguous" | "blocked" | "not_found";
      if (reconciliation.outcome === "ambiguous") status = "ambiguous";
      else if (
        searchResults.some(({ blockedExternalHost }) => blockedExternalHost) ||
        originalPortalBlocked(target.buyerProfileLink)
      ) status = "blocked";
      else status = "not_found";
      increment(report, status);
      if (reservation) {
        await finalize(
          dependencies.store,
          reservation.attemptId,
          status,
          null,
          status === "ambiguous" ? "medium" : status === "blocked" ? "blocked" : "low",
          evidence,
        );
      }
      continue;
    }

    if (config.mode === "dry_run") {
      increment(report, "found");
      continue;
    }
    if (!reservation) continue;

    const { match } = reconciliation;
    try {
      const discovery = await dependencies.discover(
        match.candidate.portal,
        requestFor(target, match),
      );
      const prepared = await dependencies.pipeline.fetchAndUpload({
        target,
        match,
        discovery,
      });
      try {
        await dependencies.store.persistFound({
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
      increment(report, status);
      await finalize(
        dependencies.store,
        reservation.attemptId,
        status,
        match.candidate.portal,
        status === "too_large" ? match.level : status,
        evidence,
      );
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
