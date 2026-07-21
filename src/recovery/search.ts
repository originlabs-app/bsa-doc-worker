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
  query: string,
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
    if (!term || seen.has(key) || terms.length >= 9) return;
    seen.add(key);
    terms.push(term);
  };

  add(target.reference);
  add(target.buyerName);
  add(buildDistinctiveQuery(target.title));
  for (const lotTitle of target.lotTitles) add(buildDistinctiveQuery(lotTitle));

  const titleTokens = target.title
    .match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)
    ?.filter((token) => normalizedTerm(token).length >= 5)
    .sort((left, right) => right.length - left.length) ?? [];
  for (const token of titleTokens) add(token);
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
    const results: PortalPublicCandidateResult[] = [];
    for (const query of buildRecoverySearchTerms(target)) {
      results.push(await backend(portal, query));
    }
    const candidates = deduplicate(
      results.flatMap(({ candidates }) => candidates),
    ).slice(0, 200);
    const blockedExternalHost = results
      .flatMap(({ blockedExternalHosts }) => blockedExternalHosts)
      .sort()[0];
    return {
      portal,
      candidates: candidates.map((candidate) => ({ portal, ...candidate })),
      ...(blockedExternalHost ? { blockedExternalHost } : {}),
    };
  };
}
