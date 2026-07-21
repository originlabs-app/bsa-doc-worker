import type { WorkerLogger } from "../logger.js";
import { runDceAnalyst } from "./agent.js";
import type {
  AgentGenerationClient,
  AnalyzeDossierInput,
  AnalyzeLearningSnapshot,
  AnalyzeUsage,
} from "./agent-types.js";
import type { AnalyzeConfig, AnalyzeMode } from "./config.js";
import {
  applyDeadlineGate,
  finalizeAnalysisDraft,
  type DeadlineGateStatus,
} from "./domain.js";
import type { FinalAnalysisUnit, FinalizedAnalysis } from "./types.js";

export class AnalyzeApplySinkRequiredError extends Error {
  readonly code = "ANALYZE_APPLY_SINK_REQUIRED";

  constructor() {
    super("ANALYZE_APPLY_SINK_REQUIRED");
    this.name = "AnalyzeApplySinkRequiredError";
  }
}

export interface AnalysisLotValues {
  number: string;
  title: string;
  relevanceScore: number;
  relevanceReason: string;
  verdict: FinalAnalysisUnit["verdict"];
  forcedZero: boolean;
  summary: FinalAnalysisUnit["summary"];
}

export interface AnalysisWritePayload {
  tenderId: string;
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
    number: unit.unit.number,
    title: unit.unit.title,
    relevanceScore: unit.score,
    relevanceReason: unit.rationale,
    verdict: unit.verdict,
    forcedZero: unit.forcedZero,
    summary: unit.summary,
  };
}

export function buildAnalysisWritePayload(input: {
  tenderId: string;
  result: AnalyzeResult;
}): AnalysisWritePayload {
  const recommended = input.result.units.find((unit) =>
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

  return {
    tenderId: input.tenderId,
    tenderValues: {
      relevance_score: input.result.score,
      relevance_reason: input.result.reason,
      need_description: needDescription,
      watchpoints,
      enriched_at: input.result.analyzedAt,
      scored_at: input.result.analyzedAt,
      dce_analyzed_at: input.result.analyzedAt,
      dce_analysis_details: {
        market_summary: input.result.marketSummary,
        units: input.result.units,
        recommended_lot: input.result.recommendedLot,
        learning: input.result.learning,
        execution: input.result.execution,
        deadline_gate: input.result.deadlineGate,
      },
      ai_analysis_cost_usd: input.result.costUsd,
      ai_analysis_model: input.result.model,
    },
    lots: input.result.units.flatMap((unit) => {
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
  const generated = await runDceAnalyst({
    dossier: input.dossier,
    learning,
    client: input.client,
    config: {
      maxSteps: input.config.maxSteps,
      maxOutputTokens: input.config.maxOutputTokens,
    },
  });
  const now = input.now ?? (() => new Date());
  const finalized = finalizeAnalysisDraft({
    draft: generated.draft,
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
