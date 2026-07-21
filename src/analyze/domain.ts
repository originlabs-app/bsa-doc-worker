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

export type DeadlineGateStatus = "passed" | "applied" | "unknown";

const DEADLINE_GATE_CAP = 40;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// Port of the edge applyDeadlineGate (enrich-nukema-tender/scorer.ts): a
// tender whose DLRO is closer than the minimum response window cannot keep a
// GO-grade score, whatever the documentary analysis says.
export function applyDeadlineGate(input: {
  analysis: FinalizedAnalysis;
  deadlineDate: string | null;
  minimumDays: number;
  now: Date;
}): FinalizedAnalysis & { deadlineGate: DeadlineGateStatus } {
  const deadlineText = input.deadlineDate?.trim() ? input.deadlineDate.trim() : null;
  if (!deadlineText) return { ...input.analysis, deadlineGate: "unknown" };
  const deadlineMs = Date.parse(deadlineText);
  if (!Number.isFinite(deadlineMs)) {
    return { ...input.analysis, deadlineGate: "unknown" };
  }

  const thresholdMs = input.now.getTime() +
    input.minimumDays * 24 * 60 * 60 * 1000;
  if (deadlineMs >= thresholdMs) {
    return { ...input.analysis, deadlineGate: "passed" };
  }

  const normalizedDeadline = /^\d{4}-\d{2}-\d{2}/.test(deadlineText)
    ? deadlineText.slice(0, 10)
    : new Date(deadlineMs).toISOString().slice(0, 10);
  const warning =
    `Délai de réponse trop court (DLRO le ${normalizedDeadline}, fenêtre minimale ${input.minimumDays} j)`;
  return {
    ...input.analysis,
    score: Math.min(input.analysis.score, DEADLINE_GATE_CAP),
    watchpoints: unique([...input.analysis.watchpoints, warning]),
    deadlineGate: "applied",
    units: input.analysis.units.map((unit) => ({
      ...unit,
      score: Math.min(unit.score, DEADLINE_GATE_CAP),
      summary: {
        ...unit.summary,
        watchpoints: unique([...unit.summary.watchpoints, warning]),
      },
    })),
  };
}

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
