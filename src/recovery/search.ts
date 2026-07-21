import {
  buildDistinctiveQuery,
  searchPortalPublicCandidates,
  type PortalConsultationCandidate,
  type PortalPublicCandidateResult,
} from "../portal-resolver.js";
import type {
  PortalSearchResult,
  RecoveryPortal,
  RecoveryTarget,
} from "./contracts.js";

export type RecoveryPublicSearchBackend = (
  portal: RecoveryPortal,
  queries: readonly string[],
) => Promise<PortalPublicCandidateResult>;

function normalizedTerm(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLocaleLowerCase("fr");
}

export function buildRecoverySearchTerms(target: RecoveryTarget): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const term = value.trim().replaceAll(/\s+/g, " ");
    const key = normalizedTerm(term);
    if (!term || seen.has(key) || terms.length >= 4) return;
    seen.add(key);
    terms.push(term);
  };

  add(buildDistinctiveQuery(target.title));
  add(target.reference);
  add(target.buyerName);
  for (const lotTitle of target.lotTitles) add(buildDistinctiveQuery(lotTitle));
  return terms;
}

function deduplicate(
  candidates: readonly PortalConsultationCandidate[],
): PortalConsultationCandidate[] {
  return [
    ...new Map(
      candidates.map((candidate) => [candidate.consultationUrl, candidate]),
    ).values(),
  ];
}

export function createRecoveryPortalSearcher(
  backend: RecoveryPublicSearchBackend = searchPortalPublicCandidates,
) {
  return async (
    portal: RecoveryPortal,
    target: RecoveryTarget,
  ): Promise<PortalSearchResult> => {
    const result = await backend(portal, buildRecoverySearchTerms(target));
    const candidates = deduplicate(result.candidates).slice(0, 200);
    const blockedExternalHost = result.blockedExternalHosts.sort()[0];
    return {
      portal,
      candidates: candidates.map((candidate) => ({ portal, ...candidate })),
      ...(blockedExternalHost ? { blockedExternalHost } : {}),
      ...(result.requestCount === undefined
        ? {}
        : { requestCount: result.requestCount }),
    };
  };
}
