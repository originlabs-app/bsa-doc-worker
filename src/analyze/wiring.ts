import type { WorkerLogger } from "../logger.js";
import type {
  AgentGenerationClient,
  AnalyzeDossierInput,
  AnalyzeLearningSnapshot,
} from "./agent-types.js";
import type { AnalyzeConfig } from "./config.js";
import {
  runAnalyzeService,
  type AnalysisResultSink,
  type AnalyzeLotContext,
  type AnalyzeResult,
} from "./service.js";

export const ANALYZE_PEEK_LIMIT = 10;

export interface AnalyzeQueueCandidate {
  queueId: string;
  tenderId: string;
  attempts: number;
}

export interface AnalyzeDossierAssembly {
  queue: AnalyzeQueueCandidate;
  companyId: string;
  recordType: string | null;
  /** Non-null exactly when record_type = 'lot' (direct lot analysis). */
  lot: AnalyzeLotContext | null;
  /**
   * Result of shouldAutoMaterializeTenderLots on the tender read at assembly
   * time (edge parity). The materialize RPC re-checks the same guards
   * server-side, so a human takeover between read and write still wins.
   */
  autoMaterializeLots: boolean;
  /**
   * Number of live lot children already materialized under this tender in the
   * DB at assembly time (0 for direct lots / standalone). LOT D roster gate:
   * an analysis producing fewer lots than the DB already holds must not
   * materialize (the RPC would flip the missing lots to review_required).
   */
  existingLotCount: number;
  existingScore: number | null;
  deadlineDate: string | null;
  dossier: AnalyzeDossierInput;
  coverage: {
    complete: boolean;
    documentsCount: number;
    omittedDocuments: number;
    totalCharacters: number;
  };
}

export type AnalyzeAssemblyReport =
  | { status: "ready"; assembly: AnalyzeDossierAssembly }
  | { status: "skipped"; reason: string }
  | { status: "not_ready"; reason: string };

export interface AnalyzeReadStore {
  peekCandidates(limit: number, observedAt: string): Promise<AnalyzeQueueCandidate[]>;
  assembleCandidate(candidate: AnalyzeQueueCandidate): Promise<AnalyzeAssemblyReport>;
  readCurrentScore(tenderId: string): Promise<number | null>;
}

export type AnalyzeClaimResult = "claimed" | "skipped" | "unavailable";

export interface AnalyzeApplyStore {
  claim(queueId: string): Promise<AnalyzeClaimResult>;
  createResultSink(assembly: AnalyzeDossierAssembly): AnalysisResultSink;
  markDone(queueId: string, processedAt: string): Promise<void>;
  markPending(queueId: string, issue: string): Promise<void>;
  markFailed(queueId: string, attempts: number, issue: string): Promise<void>;
}

export interface AnalyzeOneShotDependencies {
  readStore: AnalyzeReadStore;
  applyStore?: AnalyzeApplyStore;
  client: AgentGenerationClient;
  recallLearning(assembly: AnalyzeDossierAssembly): Promise<AnalyzeLearningSnapshot>;
  recordLearningUsage?(ruleIds: string[]): Promise<void>;
  logger?: WorkerLogger;
}

export type AnalyzeOneShotReport =
  | { mode: "off"; status: "off" }
  | { mode: "shadow" | "apply"; status: "empty" }
  | {
      mode: "shadow" | "apply";
      status: "skipped" | "unavailable" | "not_ready" | "failed";
      queueId: string;
      tenderId: string;
      issue: string;
    }
  | {
      mode: "shadow" | "apply";
      status: "analyzed";
      queueId: string;
      tenderId: string;
      existingScore: number | null;
      analyzedScore: number;
      delta: number | null;
      result: AnalyzeResult;
    };

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,100}$/;
/** Mirrors the peek query filter (status.eq.failed,attempts.lt.3): a row at 3 is terminal. */
export const ANALYZE_MAX_ATTEMPTS = 3;
const LAST_ERROR_DETAIL_MAX = 300;
const LOG_MESSAGE_MAX = 500;

/** Short machine identifier for metrics/state; never carries provider bodies. */
export function codeOf(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof code === "string" && ERROR_CODE_PATTERN.test(code)) {
    return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return ERROR_CODE_PATTERN.test(message)
    ? message
    : "ANALYZE_FAILED";
}

function redactUrlQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s"']*\?)[^\s"']*/g, "$1[REDACTED]");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return redactUrlQueries(message.trim());
}

function detailOf(error: unknown): string {
  const message = messageOf(error);
  const name = error instanceof Error && error.name && error.name !== "Error"
    ? error.name
    : null;
  return name ? (message ? `${name}: ${message}` : name) : message;
}

/**
 * last_error persisted on the queue row: keeps the short code as identifier
 * but appends the real (redacted, truncated) detail so failures stay
 * diagnosable — the raw "ANALYZE_FAILED" alone made prod failures opaque.
 */
export function buildLastError(error: unknown): string {
  const code = codeOf(error);
  const message = messageOf(error);
  // A message that only restates the code (typed guard errors) adds nothing:
  // keep last_error identical to the historical short form.
  if (!message || message === code) return code;
  return `${code}: ${truncate(detailOf(error), LAST_ERROR_DETAIL_MAX)}`;
}

function stackHead(error: unknown): string | null {
  if (!(error instanceof Error) || !error.stack) return null;
  return redactUrlQueries(error.stack.split("\n").slice(0, 3).join("\n"));
}

function logShadowResult(input: {
  logger: WorkerLogger | undefined;
  assembly: AnalyzeDossierAssembly;
  result: AnalyzeResult;
  existingScore: number | null;
  observedAt: string;
}): void {
  const delta = input.existingScore === null
    ? null
    : input.result.score - input.existingScore;
  input.logger?.info("analyze_shadow_comparison", {
    queue_id: input.assembly.queue.queueId,
    tender_id: input.assembly.queue.tenderId,
    existing_score: input.existingScore,
    shadow_score: input.result.score,
    delta,
    score_observed_at: input.observedAt,
    forced_zero: input.result.forcedZero,
    deadline_gate: input.result.deadlineGate,
    recommended_lot: input.result.recommendedLot,
    model: input.result.model,
    cost_usd: input.result.costUsd,
    units_count: input.result.units.length,
    coverage_complete: input.assembly.coverage.complete,
    omitted_documents: input.assembly.coverage.omittedDocuments,
    ...input.result.learning,
    ...input.result.execution,
  });
  for (const unit of input.result.units) {
    input.logger?.info("analyze_shadow_unit", {
      queue_id: input.assembly.queue.queueId,
      tender_id: input.assembly.queue.tenderId,
      unit: unit.unit,
      criteria: unit.criteria,
      unknown_criteria: unit.unknownCriteria,
      score: unit.score,
      verdict: unit.verdict,
      forced_zero: unit.forcedZero,
      rationale: unit.rationale,
      summary: unit.summary,
      redhibitory_reasons: unit.redhibitoryReasons,
      redhibitory_watchpoints: unit.redhibitoryWatchpoints,
      citation_document_ids: [...new Set(
        unit.citations.map((citation) => citation.documentId),
      )],
    });
  }
}

function requireDependencies(
  dependencies: AnalyzeOneShotDependencies | undefined,
): AnalyzeOneShotDependencies {
  if (!dependencies) throw new Error("ANALYZE_DEPENDENCIES_REQUIRED");
  return dependencies;
}

export async function runAnalyzeOneShot(
  config: AnalyzeConfig,
  optionalDependencies?: AnalyzeOneShotDependencies,
  runtime: { now?: () => Date } = {},
): Promise<AnalyzeOneShotReport> {
  if (config.mode === "off") return { mode: "off", status: "off" };
  const dependencies = requireDependencies(optionalDependencies);
  const now = runtime.now ?? (() => new Date());
  const candidates = await dependencies.readStore.peekCandidates(
    ANALYZE_PEEK_LIMIT,
    now().toISOString(),
  );
  if (candidates.length === 0) return { mode: config.mode, status: "empty" };

  for (const candidate of candidates) {
    let claimed = false;
    try {
      if (config.mode === "apply") {
        if (!dependencies.applyStore) {
          throw new Error("ANALYZE_APPLY_STORE_REQUIRED");
        }
        const claim = await dependencies.applyStore.claim(candidate.queueId);
        if (claim !== "claimed") {
          return {
            mode: "apply",
            status: claim,
            queueId: candidate.queueId,
            tenderId: candidate.tenderId,
            issue: `ANALYZE_QUEUE_${claim.toUpperCase()}`,
          };
        }
        claimed = true;
      }

      const assembled = await dependencies.readStore.assembleCandidate(candidate);
      if (assembled.status === "skipped") {
        if (config.mode === "shadow") continue;
        return {
          mode: config.mode,
          status: "skipped",
          queueId: candidate.queueId,
          tenderId: candidate.tenderId,
          issue: assembled.reason,
        };
      }
      if (assembled.status === "not_ready") {
        if (config.mode === "apply") {
          await dependencies.applyStore!.markPending(candidate.queueId, assembled.reason);
        }
        return {
          mode: config.mode,
          status: "not_ready",
          queueId: candidate.queueId,
          tenderId: candidate.tenderId,
          issue: assembled.reason,
        };
      }

      const assembly = assembled.assembly;
      const sink = config.mode === "apply"
        ? dependencies.applyStore!.createResultSink(assembly)
        : undefined;
      const serviceReport = await runAnalyzeService({
        config,
        dossier: assembly.dossier,
        deadlineDate: assembly.deadlineDate,
        lot: assembly.lot,
        client: dependencies.client,
        recallLearning: () => dependencies.recallLearning(assembly),
        ...(sink ? { sink } : {}),
        ...(config.mode === "apply" && dependencies.recordLearningUsage
          ? { recordLearningUsage: dependencies.recordLearningUsage }
          : {}),
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
        now,
      });
      if (serviceReport.status !== "analyzed") {
        throw new Error("ANALYZE_SERVICE_DID_NOT_ANALYZE");
      }

      let existingScore = assembly.existingScore;
      if (config.mode === "shadow") {
        existingScore = await dependencies.readStore.readCurrentScore(
          candidate.tenderId,
        );
        logShadowResult({
          logger: dependencies.logger,
          assembly,
          result: serviceReport.result,
          existingScore,
          observedAt: now().toISOString(),
        });
      } else {
        await dependencies.applyStore!.markDone(
          candidate.queueId,
          now().toISOString(),
        );
      }

      return {
        mode: config.mode,
        status: "analyzed",
        queueId: candidate.queueId,
        tenderId: candidate.tenderId,
        existingScore,
        analyzedScore: serviceReport.result.score,
        delta: existingScore === null
          ? null
          : serviceReport.result.score - existingScore,
        result: serviceReport.result,
      };
    } catch (error) {
      const issue = codeOf(error);
      dependencies.logger?.info("analyze_error_detail", {
        queue_id: candidate.queueId,
        tender_id: candidate.tenderId,
        code: issue,
        name: error instanceof Error ? error.name : typeof error,
        message: truncate(messageOf(error), LOG_MESSAGE_MAX),
        stack_head: stackHead(error),
      });
      if (config.mode === "apply" && claimed && dependencies.applyStore) {
        const attempts = candidate.attempts + 1;
        await dependencies.applyStore.markFailed(
          candidate.queueId,
          attempts,
          buildLastError(error),
        );
        if (attempts >= ANALYZE_MAX_ATTEMPTS) {
          dependencies.logger?.info("analyze_row_terminal", {
            queue_id: candidate.queueId,
            tender_id: candidate.tenderId,
            attempts,
            code: issue,
          });
        }
      }
      dependencies.logger?.info("analyze_one_shot_failed", {
        mode: config.mode,
        queue_id: candidate.queueId,
        tender_id: candidate.tenderId,
        issue,
      });
      return {
        mode: config.mode,
        status: "failed",
        queueId: candidate.queueId,
        tenderId: candidate.tenderId,
        issue,
      };
    }
  }

  return { mode: config.mode, status: "empty" };
}
