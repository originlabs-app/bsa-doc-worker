import type {
  MatchEvidence,
  PortalCandidate,
  RecoveryTarget,
} from "./contracts.js";

const STOP_WORDS = new Set([
  "a",
  "au",
  "aux",
  "avec",
  "dans",
  "des",
  "de",
  "du",
  "en",
  "et",
  "la",
  "le",
  "les",
  "lot",
  "lots",
  "pour",
  "sur",
  "travaux",
]);

const BUYER_GENERIC_WORDS = new Set([
  "agglomeration",
  "centre",
  "chu",
  "communaute",
  "commune",
  "conseil",
  "departement",
  "etablissement",
  "ghu",
  "habitat",
  "hlm",
  "hospitalier",
  "hopital",
  "hopitaux",
  "mairie",
  "metropole",
  "ministere",
  "oph",
  "public",
  "publique",
  "regional",
  "region",
  "sa",
  "sante",
  "societe",
  "ville",
]);

const GEOGRAPHIC_ORGANIZATION_WORDS = new Set([
  "communaute",
  "commune",
  "departement",
  "eurometropole",
  "mairie",
  "metropole",
  "regional",
  "region",
  "ville",
]);

interface MatchingOptions {
  now?: Date;
}

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

function lightStem(token: string): string {
  if (token.length < 4) return token;
  if (token.endsWith("aux") && token.length > 5) {
    return `${token.slice(0, -3)}al`;
  }
  return /[sx]$/.test(token) ? token.slice(0, -1) : token;
}

function normalizedStemmed(value: string): string {
  return normalize(value).split(" ").map(lightStem).join(" ");
}

function distinctiveTokens(
  value: string,
  extraStopWords: ReadonlySet<string> = new Set(),
): Set<string> {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((token) => !STOP_WORDS.has(token))
      .map(lightStem)
      .filter((token) => token.length >= 3)
      .filter((token) => !/^\d+$/.test(token))
      .filter((token) => !STOP_WORDS.has(token))
      .filter((token) => !extraStopWords.has(token)),
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

function titlePrefixMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizedStemmed(left);
  const normalizedRight = normalizedStemmed(right);
  const shorter = normalizedLeft.length <= normalizedRight.length
    ? normalizedLeft
    : normalizedRight;
  const longer = normalizedLeft.length <= normalizedRight.length
    ? normalizedRight
    : normalizedLeft;
  return shorter.length >= 20 && longer.startsWith(shorter);
}

function containsGeographicOrganizationWord(value: string): boolean {
  return normalize(value)
    .split(" ")
    .some((token) => GEOGRAPHIC_ORGANIZATION_WORDS.has(token));
}

function buyerEvidence(
  targetBuyer: string,
  candidateBuyer: string,
): {
  exact: boolean;
  matched: boolean;
  overlap: number;
  shared: number;
} {
  const exact = normalize(targetBuyer).length > 0 &&
    normalize(targetBuyer) === normalize(candidateBuyer);
  const targetTokens = distinctiveTokens(targetBuyer, BUYER_GENERIC_WORDS);
  const candidateTokens = distinctiveTokens(candidateBuyer, BUYER_GENERIC_WORDS);
  const shared = intersectionSize(targetTokens, candidateTokens);
  const denominator = Math.min(targetTokens.size, candidateTokens.size);
  const overlap = denominator === 0 ? 0 : shared / denominator;
  const organizationMismatch =
    containsGeographicOrganizationWord(targetBuyer) !==
    containsGeographicOrganizationWord(candidateBuyer);
  const geographicContext = containsGeographicOrganizationWord(targetBuyer) ||
    containsGeographicOrganizationWord(candidateBuyer);
  const tokenMatched = !organizationMismatch &&
    (!geographicContext || shared >= 2) &&
    ((overlap >= 0.75 && shared >= 1) || (overlap >= 0.5 && shared >= 2));
  return { exact, matched: exact || tokenMatched, overlap, shared };
}

function matchedLots(
  targetLots: readonly string[],
  candidateLots: readonly string[],
): number {
  const possibleMatches: Array<{
    targetIndex: number;
    candidateIndex: number;
    similarity: number;
  }> = [];
  for (const [targetIndex, targetLot] of targetLots.entries()) {
    const targetTokens = distinctiveTokens(targetLot);
    for (const [candidateIndex, candidateLot] of candidateLots.entries()) {
      const similarity = jaccard(
        targetTokens,
        distinctiveTokens(candidateLot),
      );
      if (similarity >= 0.55) {
        possibleMatches.push({ targetIndex, candidateIndex, similarity });
      }
    }
  }
  possibleMatches.sort((left, right) => right.similarity - left.similarity);
  const usedTargets = new Set<number>();
  const usedCandidates = new Set<number>();
  for (const match of possibleMatches) {
    if (
      usedTargets.has(match.targetIndex) ||
      usedCandidates.has(match.candidateIndex)
    ) continue;
    usedTargets.add(match.targetIndex);
    usedCandidates.add(match.candidateIndex);
  }
  return usedTargets.size;
}

function deadlineStatus(
  deadlineAt: string | undefined,
  now: Date,
): MatchEvidence["deadlineStatus"] {
  if (!deadlineAt) return "unknown";
  const deadline = new Date(deadlineAt);
  if (Number.isNaN(deadline.getTime())) return "unknown";
  return deadline.getTime() >= now.getTime() ? "coherent" : "expired";
}

function placeUmbrellaCompatible(
  targetBuyer: string,
  candidate: PortalCandidate,
): boolean {
  if (candidate.portal !== "place") return false;
  const target = normalize(targetBuyer);
  const buyer = normalize(candidate.buyerName);
  const mappings: Array<{ entities: RegExp; umbrella: RegExp }> = [
    { entities: /\b(?:oppic|drac|ensba)\b/, umbrella: /\bculture\b/ },
    { entities: /\bsid\b/, umbrella: /\b(?:armees|defense)\b/ },
    {
      entities: /\b(?:ap hp|assistance publique hopitaux de paris|novo)\b/,
      umbrella: /\bsante\b/,
    },
    { entities: /\bfilieris\b/, umbrella: /\bsecurite sociale\b/ },
    {
      entities: /\b(?:efs|etablissement francais du sang)\b/,
      umbrella: /\b(?:ministeres sociaux|affaires sociales|travail)\b/,
    },
  ];
  return mappings.some(
    ({ entities, umbrella }) => entities.test(target) && umbrella.test(buyer),
  );
}

export function classifyRecoveryCandidate(
  target: RecoveryTarget,
  candidate: PortalCandidate,
  options: MatchingOptions = {},
): MatchEvidence {
  const targetTitleTokens = distinctiveTokens(target.title);
  const candidateTitleTokens = distinctiveTokens(candidate.canonicalTitle);
  const titleJaccard = jaccard(targetTitleTokens, candidateTitleTokens);
  const prefixMatch = titlePrefixMatch(target.title, candidate.canonicalTitle);
  const titleMatched = prefixMatch || titleJaccard >= 0.75;
  const referenceExact = normalizedReference(target.reference).length > 0 &&
    normalizedReference(target.reference) ===
      normalizedReference(candidate.reference);
  const buyer = buyerEvidence(target.buyerName, candidate.buyerName);
  const candidateLots = candidate.lotTitles ?? [];
  const lotTitleMatches = matchedLots(target.lotTitles, candidateLots);
  const lotTokens = distinctiveTokens(target.lotTitles.join(" "));
  const candidateLotTokens = distinctiveTokens(candidateLots.join(" "));
  const lotTokenHits = intersectionSize(lotTokens, candidateLotTokens);
  const deadline = deadlineStatus(candidate.deadlineAt, options.now ?? new Date());
  const umbrellaCompatible = placeUmbrellaCompatible(target.buyerName, candidate);

  const strongByTitleBuyer = titleMatched && buyer.matched;
  const strongByTitleLots = titleMatched && lotTitleMatches >= 2;
  const strongByBuyerLots = buyer.matched && lotTitleMatches >= 2;
  const strongByLots = lotTitleMatches >= 3 && titleJaccard >= 0.4;
  const otherwiseStrong = strongByTitleBuyer || strongByTitleLots ||
    strongByBuyerLots || strongByLots;
  const lotConfirmedStrong = strongByTitleLots || strongByBuyerLots || strongByLots;
  const deadlineAllowsStrong = deadline === "coherent" ||
    (deadline === "unknown" && lotConfirmedStrong);

  let level: MatchEvidence["level"] = "low";
  if (referenceExact && (titleMatched || buyer.matched)) {
    level = "exact";
  } else if (deadlineAllowsStrong && otherwiseStrong) {
    level = "strong";
  } else if (
    titleMatched ||
    (titleMatched && umbrellaCompatible) ||
    (buyer.matched && titleJaccard >= 0.45) ||
    otherwiseStrong
  ) {
    level = "medium";
  }

  return {
    level,
    referenceExact,
    buyerExact: buyer.exact,
    buyerMatched: buyer.matched,
    buyerTokenOverlap: buyer.overlap,
    buyerSharedTokens: buyer.shared,
    titleMatched,
    titlePrefixMatch: prefixMatch,
    titleJaccard,
    lotTokenHits,
    lotTitleMatches,
    deadlineStatus: deadline,
    placeUmbrellaCompatible: umbrellaCompatible,
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
  options: MatchingOptions = {},
): ReconciliationResult {
  const evidence = candidates
    .map((candidate) => classifyRecoveryCandidate(target, candidate, options))
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
