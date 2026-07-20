import { z } from "zod";

import type {
  AgentGenerationClient,
  AnalyzeDossierInput,
  AnalyzeLearningSnapshot,
  AnalyzeUsage,
  DceAnalystResult,
} from "./agent-types.js";
import { AgentAnalysisDraftSchema } from "./types.js";

const MAX_STRUCTURED_ATTEMPTS = 2;
export const MAX_ANALYZE_STEPS = 12;
export const MAX_ANALYZE_OUTPUT_TOKENS = 8_192;

export class AnalyzeLlmInvalidOutputError extends Error {
  readonly code = "ANALYZE_LLM_INVALID_OUTPUT";

  constructor(
    public readonly attempts: number,
    public readonly costUsd: number,
    options?: ErrorOptions,
  ) {
    super("ANALYZE_LLM_INVALID_OUTPUT", options);
    this.name = "AnalyzeLlmInvalidOutputError";
  }
}

export class AnalyzeStepBudgetError extends Error {
  readonly code = "ANALYZE_STEP_BUDGET_EXCEEDED";

  constructor() {
    super("ANALYZE_STEP_BUDGET_EXCEEDED");
    this.name = "AnalyzeStepBudgetError";
  }
}

export class AnalyzeTokenBudgetError extends Error {
  readonly code = "ANALYZE_TOKEN_BUDGET_EXCEEDED";

  constructor() {
    super("ANALYZE_TOKEN_BUDGET_EXCEEDED");
    this.name = "AnalyzeTokenBudgetError";
  }
}

export class AnalyzeDraftGroundingError extends Error {
  readonly code = "ANALYZE_DRAFT_NOT_GROUNDED";

  constructor() {
    super("ANALYZE_DRAFT_NOT_GROUNDED");
    this.name = "AnalyzeDraftGroundingError";
  }
}

export class SdkAnalyzeStructuredOutputError extends Error {
  readonly code = "SDK_ANALYZE_STRUCTURED_OUTPUT_INVALID";

  constructor(
    public readonly costUsd: number,
    public readonly usage: AnalyzeUsage,
    public readonly stepsUsed: number,
    options?: ErrorOptions,
  ) {
    super("SDK_ANALYZE_STRUCTURED_OUTPUT_INVALID", options);
    this.name = "SdkAnalyzeStructuredOutputError";
  }
}

function roundedCost(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function emptyUsage(): AnalyzeUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(left: AnalyzeUsage, right: AnalyzeUsage): AnalyzeUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function assertConfig(config: { maxSteps: number; maxOutputTokens: number }): void {
  if (!Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1 ||
      config.maxSteps > MAX_ANALYZE_STEPS) {
    throw new AnalyzeStepBudgetError();
  }
  if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 ||
      config.maxOutputTokens > MAX_ANALYZE_OUTPUT_TOKENS) {
    throw new Error("ANALYZE_TOKEN_BUDGET_INVALID");
  }
}

function assertDraftGrounded(
  draft: DceAnalystResult["draft"],
  dossier: AnalyzeDossierInput,
): void {
  const documentIds = new Set(dossier.documents.map((document) => document.id));
  for (const unit of draft.units) {
    const citedIds = [
      ...unit.citations.map((citation) => citation.documentId),
      ...unit.requiredQualifications.map((qualification) =>
        qualification.sourceDocumentId
      ),
      ...(unit.socialInsertion?.sourceDocumentId
        ? [unit.socialInsertion.sourceDocumentId]
        : []),
    ];
    if (citedIds.some((documentId) => !documentIds.has(documentId))) {
      throw new AnalyzeDraftGroundingError();
    }
  }

  const explicitLotNumbers = new Set(dossier.documents.flatMap((document) =>
    document.lotNumber ? [document.lotNumber] : []
  ));
  if (explicitLotNumbers.size === 0) return;
  const analyzedLotNumbers = new Set(draft.units.flatMap((unit) =>
    unit.unit.kind === "lot" ? [unit.unit.number] : []
  ));
  if (
    draft.units.some((unit) => unit.unit.kind === "market") ||
    [...explicitLotNumbers].some((number) => !analyzedLotNumbers.has(number))
  ) {
    throw new AnalyzeDraftGroundingError();
  }
}

export async function runDceAnalyst(input: {
  dossier: AnalyzeDossierInput;
  learning: AnalyzeLearningSnapshot;
  client: AgentGenerationClient;
  config: { maxSteps: number; maxOutputTokens: number };
}): Promise<DceAnalystResult> {
  assertConfig(input.config);
  let costUsd = 0;
  let usage = emptyUsage();
  let stepsUsed = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_STRUCTURED_ATTEMPTS; attempt += 1) {
    const remainingSteps = input.config.maxSteps - stepsUsed;
    const remainingOutputTokens = input.config.maxOutputTokens - usage.outputTokens;
    if (remainingSteps < 1) throw new AnalyzeStepBudgetError();
    if (remainingOutputTokens < 1) throw new AnalyzeTokenBudgetError();
    try {
      const generated = await input.client.generate({
        dossier: input.dossier,
        learning: input.learning,
        repair: attempt > 1,
        maxSteps: remainingSteps,
        maxOutputTokens: remainingOutputTokens,
      });
      costUsd = roundedCost(costUsd + generated.costUsd);
      usage = addUsage(usage, generated.usage);
      stepsUsed += generated.stepsUsed;
      if (stepsUsed > input.config.maxSteps) {
        throw new AnalyzeStepBudgetError();
      }
      if (usage.outputTokens > input.config.maxOutputTokens) {
        throw new AnalyzeTokenBudgetError();
      }
      const draft = AgentAnalysisDraftSchema.parse(generated.output);
      assertDraftGrounded(draft, input.dossier);
      return { draft, attempts: attempt, stepsUsed, costUsd, usage };
    } catch (error) {
      if (
        error instanceof AnalyzeStepBudgetError ||
        error instanceof AnalyzeTokenBudgetError
      ) throw error;
      if (error instanceof SdkAnalyzeStructuredOutputError) {
        costUsd = roundedCost(costUsd + error.costUsd);
        usage = addUsage(usage, error.usage);
        stepsUsed += error.stepsUsed;
        if (stepsUsed > input.config.maxSteps) {
          throw new AnalyzeStepBudgetError();
        }
        if (usage.outputTokens > input.config.maxOutputTokens) {
          throw new AnalyzeTokenBudgetError();
        }
        lastError = error;
        continue;
      }
      if (error instanceof z.ZodError) {
        lastError = error;
        continue;
      }
      if (error instanceof AnalyzeDraftGroundingError) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw new AnalyzeLlmInvalidOutputError(
    MAX_STRUCTURED_ATTEMPTS,
    costUsd,
    { cause: lastError },
  );
}
