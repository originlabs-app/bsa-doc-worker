import type { CriterionKey, CriterionScores } from "./types.js";

export const RELEVANCE_THRESHOLD = 70;

export const CRITERION_WEIGHTS: Record<CriterionKey, number> = {
  metier: 30,
  geo: 20,
  montant: 20,
  procedure: 15,
  certifications: 15,
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Parity source: BSA Copilot origin/main@a185631 scorer.ts. */
export function computeFinalScoreFromCriteria(
  criteria: CriterionScores,
  unknownCriteria: ReadonlySet<CriterionKey>,
): number {
  const businessGate = criteria.metier / CRITERION_WEIGHTS.metier;
  const otherCriteria: CriterionKey[] = [
    "geo",
    "montant",
    "procedure",
    "certifications",
  ];
  const knownOtherCriteria = otherCriteria.filter(
    (criterion) => !unknownCriteria.has(criterion),
  );
  const knownMax = knownOtherCriteria.reduce(
    (sum, criterion) => sum + CRITERION_WEIGHTS[criterion],
    0,
  );
  if (knownMax <= 0) return 0;
  const knownScore = knownOtherCriteria.reduce(
    (sum, criterion) => sum + criteria[criterion],
    0,
  );
  return clampScore(businessGate * (knownScore / knownMax) * 100);
}
