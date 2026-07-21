import type { WorkerLogger } from "../logger.js";
import { runDceAnalyst } from "./agent.js";
import type {
  AgentGenerationClient,
  AnalyzeDossierInput,
  AnalyzeLearningSnapshot,
  AnalyzeUsage,
} from "./agent-types.js";
import { documentLotNumbers, runChunkedDceAnalyst } from "./chunking.js";
import type { AnalyzeConfig, AnalyzeMode } from "./config.js";
import {
  applyDeadlineGate,
  finalizeAnalysisDraft,
  type DeadlineGateStatus,
} from "./domain.js";
import { degradeUngroundedBusinessFields } from "./grounding.js";
import type {
  FinalAnalysisUnit,
  FinalizedAnalysis,
  LotBusinessFields,
} from "./types.js";

export class AnalyzeApplySinkRequiredError extends Error {
  readonly code = "ANALYZE_APPLY_SINK_REQUIRED";

  constructor() {
    super("ANALYZE_APPLY_SINK_REQUIRED");
    this.name = "AnalyzeApplySinkRequiredError";
  }
}

export interface AnalysisLotValues {
  sourceLotKey: string | null;
  number: string | null;
  title: string | null;
  relevanceScore: number | null;
  relevanceReason: string;
  verdict: FinalAnalysisUnit["verdict"] | null;
  forcedZero: boolean;
  summary: FinalAnalysisUnit["summary"] | null;
  businessFields: LotBusinessFields | null;
}

/**
 * Direct-lot analysis context: the tender being analyzed IS a lot record and
 * scores/states must be written on it through its market parent (lock-safe RPC).
 */
export interface AnalyzeLotContext {
  parentTenderId: string;
  number: string | null;
  title: string | null;
  sourceLotKey: string | null;
}

export interface AnalysisWritePayload {
  tenderId: string;
  /** LLM roster declaration, gating the materialization when no reliable
   * roster source exists in the assembly (LOT D). */
  rosterComplete: boolean;
  tenderValues: Record<string, unknown>;
  lots: AnalysisLotValues[];
  ledger: {
    tenderId: string;
    step: "dce_scoring";
    model: string;
    costUsd: number;
    metadata: Record<string, unknown>;
  };
}

export interface AnalysisResultSink {
  write(payload: AnalysisWritePayload): Promise<void>;
}

export type AnalyzeResult = FinalizedAnalysis & {
  deadlineGate: DeadlineGateStatus;
  analyzedAt: string;
  model: string;
  costUsd: number;
  usage: AnalyzeUsage;
  learning: {
    lessons_count: number;
    rules_count: number;
    learning_applied: boolean;
  };
  execution: {
    attempts: number;
    steps_used: number;
    max_steps: number;
    max_output_tokens: number;
  };
};

export type AnalyzeServiceReport =
  | { mode: "off"; status: "off" }
  | { mode: Exclude<AnalyzeMode, "off">; status: "analyzed"; result: AnalyzeResult };

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function lotValues(unit: FinalAnalysisUnit): AnalysisLotValues | null {
  if (unit.unit.kind !== "lot") return null;
  return {
    sourceLotKey: null,
    number: unit.unit.number,
    title: unit.unit.title,
    relevanceScore: unit.score,
    relevanceReason: unit.rationale,
    verdict: unit.verdict,
    forcedZero: unit.forcedZero,
    summary: unit.summary,
    businessFields: unit.businessFields ?? null,
  };
}

// Same lot-number normalization family as the edge (handler.ts
// normalizeLotNumberValue): "Lot n°01a" → "1A".
export function normalizeLotNumberValue(value: string | null): string | null {
  if (value === null) return null;
  const match = value.trim().match(
    /^(?:lot\s*(?:n\s*[°ºo]?\s*)?)?0*([0-9]{1,3})([a-z]?)$/i,
  );
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0
    ? `${parsed}${(match[2] ?? "").toUpperCase()}`
    : null;
}

function normalizeForLotMatching(value: string | null): string {
  return (value ?? "")
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\blot\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const NO_MATCHING_UNIT_REASON =
  "Lot non retrouvé avec certitude dans les documents analysés";

// Edge parity (findDocumentaryLotForTender/findScoringVerdictForLot): match by
// normalized lot number first, then by normalized title equality/containment.
function findUnitForTargetLot(
  units: FinalAnalysisUnit[],
  lot: AnalyzeLotContext,
): FinalAnalysisUnit | null {
  const lotUnits = units.filter((unit) => unit.unit.kind === "lot");
  const targetNumber = normalizeLotNumberValue(lot.number);
  if (targetNumber) {
    const byNumber = lotUnits.find((unit) =>
      unit.unit.kind === "lot" &&
      normalizeLotNumberValue(unit.unit.number) === targetNumber
    );
    if (byNumber) return byNumber;
  }
  const targetTitle = normalizeForLotMatching(lot.title);
  if (!targetTitle) return null;
  return lotUnits.find((unit) => {
    if (unit.unit.kind !== "lot") return false;
    const candidateTitle = normalizeForLotMatching(unit.unit.title);
    return candidateTitle === targetTitle ||
      candidateTitle.includes(targetTitle) ||
      targetTitle.includes(candidateTitle);
  }) ?? null;
}

export function buildAnalysisWritePayload(input: {
  tenderId: string;
  result: AnalyzeResult;
  lot?: AnalyzeLotContext | null;
}): AnalysisWritePayload {
  const targetLot = input.lot ?? null;
  const matchedUnit = targetLot
    ? findUnitForTargetLot(input.result.units, targetLot)
    : null;
  const recommended = matchedUnit ?? input.result.units.find((unit) =>
    unit.verdict === "recommended"
  ) ?? input.result.units[0];
  const summary = recommended?.summary;
  const needDescription = summary
    ? [summary.scope, ...summary.services].join("\n")
    : input.result.marketSummary;
  const watchpoints = unique([
    ...input.result.watchpoints,
    ...input.result.units.flatMap((unit) => unit.summary.watchpoints),
  ]);
  const dceAnalysisDetails = {
    market_summary: input.result.marketSummary,
    units: input.result.units,
    recommended_lot: input.result.recommendedLot,
    learning: input.result.learning,
    execution: input.result.execution,
    deadline_gate: input.result.deadlineGate,
  };
  // Direct-lot analysis: score, states and fit locks belong to the lock-safe
  // sync_tender_lot_analysis RPC (edge parity). The tender row itself only
  // receives neutral fields.
  const tenderValues: Record<string, unknown> = targetLot
    ? {
      need_description: needDescription,
      watchpoints,
      enriched_at: input.result.analyzedAt,
      dce_analyzed_at: input.result.analyzedAt,
      dce_analysis_details: dceAnalysisDetails,
      ai_analysis_cost_usd: input.result.costUsd,
      ai_analysis_model: input.result.model,
    }
    : {
      relevance_score: input.result.score,
      relevance_reason: input.result.reason,
      need_description: needDescription,
      watchpoints,
      enriched_at: input.result.analyzedAt,
      scored_at: input.result.analyzedAt,
      dce_analyzed_at: input.result.analyzedAt,
      dce_analysis_details: dceAnalysisDetails,
      ai_analysis_cost_usd: input.result.costUsd,
      ai_analysis_model: input.result.model,
    };

  return {
    tenderId: input.tenderId,
    rosterComplete: input.result.rosterComplete,
    tenderValues,
    lots: targetLot
      ? [{
        sourceLotKey: targetLot.sourceLotKey,
        number: targetLot.number,
        title: targetLot.title,
        // No confident unit match → null score: the RPC then sets the lot to
        // review_required instead of writing a wrong score.
        relevanceScore: matchedUnit?.score ?? null,
        relevanceReason: matchedUnit?.rationale ?? NO_MATCHING_UNIT_REASON,
        verdict: matchedUnit?.verdict ?? null,
        forcedZero: matchedUnit?.forcedZero ?? false,
        summary: matchedUnit?.summary ?? null,
        businessFields: matchedUnit?.businessFields ?? null,
      }]
      : input.result.units.flatMap((unit) => {
        const lot = lotValues(unit);
        return lot ? [lot] : [];
      }),
    ledger: {
      tenderId: input.tenderId,
      step: "dce_scoring",
      model: input.result.model,
      costUsd: input.result.costUsd,
      metadata: {
        forced_zero: input.result.forcedZero,
        lessons_count: input.result.learning.lessons_count,
        rules_count: input.result.learning.rules_count,
        learning_applied: input.result.learning.learning_applied,
        attempts: input.result.execution.attempts,
        steps_used: input.result.execution.steps_used,
      },
    },
  };
}

export async function runAnalyzeService(input: {
  config: AnalyzeConfig;
  dossier: AnalyzeDossierInput;
  deadlineDate?: string | null;
  lot?: AnalyzeLotContext | null;
  /**
   * LOT H — live lot children already in DB (assembly.existingLotCount).
   * Combined with the document lot numbers it sizes the expected roster: a
   * mother whose roster exceeds config.unitsPerCall is analyzed in chunks so
   * the expected output of every call fits in maxOutputTokens.
   */
  expectedLotCount?: number | null;
  client: AgentGenerationClient;
  recallLearning: () => Promise<AnalyzeLearningSnapshot>;
  sink?: AnalysisResultSink;
  recordLearningUsage?: (ruleIds: string[]) => Promise<void>;
  logger?: WorkerLogger;
  now?: () => Date;
}): Promise<AnalyzeServiceReport> {
  if (input.config.mode === "off") return { mode: "off", status: "off" };
  if (input.config.mode === "apply" && !input.sink) {
    throw new AnalyzeApplySinkRequiredError();
  }

  const learning = await input.recallLearning();
  // LOT H dispatch: direct lots and small rosters keep the single-call path
  // untouched; only a mother whose expected roster exceeds the per-call
  // budget goes through framing + chunk calls.
  const expectedRosterSize = Math.max(
    input.expectedLotCount ?? 0,
    documentLotNumbers(input.dossier).length,
  );
  const chunked = !input.lot && !input.dossier.targetLot &&
    expectedRosterSize > input.config.unitsPerCall;
  const generated = chunked
    ? await runChunkedDceAnalyst({
      dossier: input.dossier,
      learning,
      client: input.client,
      config: {
        maxSteps: input.config.maxSteps,
        maxOutputTokens: input.config.maxOutputTokens,
      },
      unitsPerCall: input.config.unitsPerCall,
      expectedLotCount: expectedRosterSize,
      ...(input.logger ? { logger: input.logger } : {}),
    })
    : await runDceAnalyst({
      dossier: input.dossier,
      learning,
      client: input.client,
      config: {
        maxSteps: input.config.maxSteps,
        maxOutputTokens: input.config.maxOutputTokens,
      },
    });
  const now = input.now ?? (() => new Date());
  // LOT D: degrade ungrounded business fields BEFORE finalization, so the
  // stored analysis details and the RPC payloads never carry an unproven
  // value (invented citation, unknown document, unsupported amount).
  const groundedDraft = degradeUngroundedBusinessFields({
    draft: generated.draft,
    documents: input.dossier.documents,
    tenderId: input.dossier.tender.id,
    ...(input.logger
      ? {
        log: (event: string, data: Record<string, unknown>) =>
          input.logger?.info(event, data),
      }
      : {}),
  });
  const finalized = finalizeAnalysisDraft({
    draft: groundedDraft,
    company: input.dossier.company,
    mandatoryQualifications: input.dossier.mandatoryQualifications,
  });
  const gated = applyDeadlineGate({
    analysis: finalized,
    deadlineDate: input.deadlineDate ?? null,
    minimumDays: input.config.deadlineMinDays,
    now: now(),
  });
  const result: AnalyzeResult = {
    ...gated,
    analyzedAt: now().toISOString(),
    model: input.config.model,
    costUsd: generated.costUsd,
    usage: generated.usage,
    learning: {
      lessons_count: learning.lessons.length,
      rules_count: learning.rules.length,
      learning_applied: learning.lessons.length > 0 || learning.rules.length > 0,
    },
    execution: {
      attempts: generated.attempts,
      steps_used: generated.stepsUsed,
      max_steps: input.config.maxSteps,
      max_output_tokens: input.config.maxOutputTokens,
    },
  };

  if (input.config.mode === "shadow") {
    input.logger?.info("analyze_shadow_result", {
      tender_id: input.dossier.tender.id,
      score: result.score,
      forced_zero: result.forcedZero,
      deadline_gate: result.deadlineGate,
      recommended_lot: result.recommendedLot,
      lots_count: result.units.length,
      cost_usd: result.costUsd,
      ...result.learning,
      ...result.execution,
    });
    return { mode: "shadow", status: "analyzed", result };
  }

  await input.sink!.write(buildAnalysisWritePayload({
    tenderId: input.dossier.tender.id,
    result,
    lot: input.lot ?? null,
  }));
  const ruleIds = learning.rules.map((rule) => rule.id);
  if (ruleIds.length > 0 && input.recordLearningUsage) {
    try {
      await input.recordLearningUsage(ruleIds);
    } catch (error) {
      input.logger?.info("analyze_learning_usage_failed", {
        tender_id: input.dossier.tender.id,
        rule_ids: ruleIds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { mode: "apply", status: "analyzed", result };
}
