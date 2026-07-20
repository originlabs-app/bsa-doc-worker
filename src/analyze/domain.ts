import { evaluateRedhibitoryRules } from "./redhibitory.js";
import { computeFinalScoreFromCriteria, RELEVANCE_THRESHOLD } from "./scoring.js";
import type {
  AgentAnalysisDraft,
  CompanyProfile,
  FinalAnalysisUnit,
  FinalizedAnalysis,
  FinalUnitVerdict,
  MandatoryQualification,
} from "./types.js";

function verdictFor(input: {
  blocked: boolean;
  recommended: boolean;
  score: number;
}): FinalUnitVerdict {
  if (input.blocked) return "blocked";
  if (input.score >= RELEVANCE_THRESHOLD) {
    return input.recommended ? "recommended" : "relevant";
  }
  if (input.score >= 40) return "watch";
  return "out_of_scope";
}

export function finalizeAnalysisDraft(input: {
  draft: AgentAnalysisDraft;
  company: CompanyProfile;
  mandatoryQualifications: MandatoryQualification[];
}): FinalizedAnalysis {
  const evaluated = input.draft.units.map((unit, order) => {
    const redhibitory = evaluateRedhibitoryRules({
      requiredQualifications: unit.requiredQualifications,
      mandatoryQualifications: input.mandatoryQualifications,
      company: input.company,
      socialInsertion: unit.socialInsertion,
    });
    const calculatedScore = computeFinalScoreFromCriteria(
      unit.criteria,
      new Set(unit.unknownCriteria),
    );
    return {
      unit,
      order,
      redhibitory,
      score: redhibitory.redhibitory ? 0 : calculatedScore,
    };
  });

  const accessible = evaluated.filter((entry) => !entry.redhibitory.redhibitory);
  const recommended = accessible.reduce<(typeof accessible)[number] | null>(
    (best, entry) => !best || entry.score > best.score ? entry : best,
    null,
  );
  const units: FinalAnalysisUnit[] = evaluated.map((entry) => {
    const isRecommended = entry === recommended;
    return {
      ...entry.unit,
      score: entry.score,
      forcedZero: entry.redhibitory.redhibitory,
      verdict: verdictFor({
        blocked: entry.redhibitory.redhibitory,
        recommended: isRecommended,
        score: entry.score,
      }),
      redhibitoryReasons: entry.redhibitory.reasons,
      redhibitoryWatchpoints: entry.redhibitory.watchpoints,
      matchedMandatoryQualifications:
        entry.redhibitory.matchedMandatoryQualifications,
    };
  });

  const recommendedLot = recommended?.unit.unit.kind === "lot"
    ? {
        number: recommended.unit.unit.number,
        title: recommended.unit.unit.title,
      }
    : null;
  const allBlocked = evaluated.every((entry) => entry.redhibitory.redhibitory);

  return {
    score: recommended?.score ?? 0,
    reason: recommended?.unit.rationale ?? input.draft.marketSummary,
    forcedZero: allBlocked,
    marketSummary: input.draft.marketSummary,
    recommendedLot,
    watchpoints: evaluated.flatMap((entry) => [
      ...entry.redhibitory.watchpoints,
      ...(!allBlocked && entry.redhibitory.redhibitory
        ? entry.redhibitory.reasons.map((reason) =>
            entry.unit.unit.kind === "lot"
              ? `Lot ${entry.unit.unit.number} bloqué : ${reason}`
              : reason
          )
        : []),
    ]),
    units,
  };
}
