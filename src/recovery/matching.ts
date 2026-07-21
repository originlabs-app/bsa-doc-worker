import { classifySweepCandidate } from "../sweep.js";
import type {
  MatchEvidence,
  PortalCandidate,
  RecoveryTarget,
} from "./contracts.js";

const STOP_WORDS = new Set([
  "avec",
  "dans",
  "des",
  "de",
  "du",
  "et",
  "la",
  "le",
  "les",
  "lot",
  "lots",
  "pour",
  "travaux",
]);

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
}

function normalizedReference(value: string): string {
  return normalize(value).replaceAll(" ", "");
}

function distinctiveTokens(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token.length >= 3)
      .filter((token) => !/^\d+$/.test(token))
      .filter((token) => !STOP_WORDS.has(token)),
  );
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let result = 0;
  for (const token of left) if (right.has(token)) result += 1;
  return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = intersectionSize(left, right);
  return intersection / (left.size + right.size - intersection);
}

export function classifyRecoveryCandidate(
  target: RecoveryTarget,
  candidate: PortalCandidate,
  thresholds: { strong?: number; titleOnly?: number } = {},
): MatchEvidence {
  const strongThreshold = thresholds.strong ?? 0.5;
  const titleOnlyThreshold = thresholds.titleOnly ?? 0.7;
  const targetTitleTokens = distinctiveTokens(target.title);
  const candidateTitleTokens = distinctiveTokens(candidate.canonicalTitle);
  const titleJaccard = jaccard(targetTitleTokens, candidateTitleTokens);
  const referenceExact =
    normalizedReference(target.reference).length > 0 &&
    normalizedReference(target.reference) ===
      normalizedReference(candidate.reference);
  const buyerExact =
    normalize(target.buyerName).length > 0 &&
    normalize(target.buyerName) === normalize(candidate.buyerName);
  const lotTokens = distinctiveTokens(target.lotTitles.join(" "));
  const lotTokenHits = intersectionSize(lotTokens, candidateTitleTokens);
  const strict = classifySweepCandidate(
    {
      protocol: "B",
      title: target.title,
      reference: target.reference,
      buyerName: target.buyerName,
    },
    candidate,
  );

  let level: MatchEvidence["level"] = "low";
  if (referenceExact || (strict.accepted && strict.matchedBy === "exact_reference")) {
    level = "exact";
  } else if (
    strict.accepted ||
    (buyerExact && titleJaccard >= strongThreshold) ||
    titleJaccard >= titleOnlyThreshold
  ) {
    level = "strong";
  } else if (buyerExact || titleJaccard >= 0.2 || lotTokenHits >= 2) {
    level = "medium";
  }

  return {
    level,
    referenceExact,
    buyerExact,
    titleJaccard,
    lotTokenHits,
    candidate,
  };
}

const RANK: Record<MatchEvidence["level"], number> = {
  exact: 3,
  strong: 2,
  medium: 1,
  low: 0,
};

const PORTAL_RANK = {
  aw_solutions: 0,
  place: 1,
  maximilien: 2,
} as const;

export type ReconciliationResult =
  | {
      outcome: "matched";
      match: MatchEvidence & { level: "exact" | "strong" };
      evidence: MatchEvidence[];
    }
  | { outcome: "ambiguous"; evidence: MatchEvidence[] }
  | { outcome: "not_found"; evidence: MatchEvidence[] };

export function reconcilePortalCandidates(
  target: RecoveryTarget,
  candidates: readonly PortalCandidate[],
  thresholds: { strong?: number; titleOnly?: number } = {},
): ReconciliationResult {
  const evidence = candidates
    .map((candidate) => classifyRecoveryCandidate(target, candidate, thresholds))
    .sort((left, right) =>
      RANK[right.level] - RANK[left.level] ||
      right.titleJaccard - left.titleJaccard ||
      PORTAL_RANK[left.candidate.portal] - PORTAL_RANK[right.candidate.portal],
    );
  const best = evidence[0];
  if (!best || best.level === "low") return { outcome: "not_found", evidence };
  if (best.level === "medium") return { outcome: "ambiguous", evidence };

  const tied = evidence.filter((item) => item.level === best.level);
  const identities = new Set(
    tied.map(
      ({ candidate }) =>
        `${normalizedReference(candidate.reference)}|${normalize(candidate.canonicalTitle)}`,
    ),
  );
  if (identities.size > 1) return { outcome: "ambiguous", evidence };
  return {
    outcome: "matched",
    match: best as MatchEvidence & { level: "exact" | "strong" },
    evidence,
  };
}
