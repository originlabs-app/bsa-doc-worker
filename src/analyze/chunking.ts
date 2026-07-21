import { z } from "zod";

import {
  addUsage,
  assertDraftGrounded,
  assertUnitsCitationsGrounded,
  emptyUsage,
  roundedCost,
  SdkAnalyzeStructuredOutputError,
} from "./agent.js";
import type {
  AgentGenerationClient,
  AnalyzeCallMission,
  AnalyzeDossierInput,
  AnalyzeLearningSnapshot,
  AnalyzeRosterLot,
  AnalyzeUsage,
  DceAnalystResult,
} from "./agent-types.js";
import type { WorkerLogger } from "../logger.js";
import { normalizeLotNumberValue } from "./service.js";
import {
  AgentAnalysisDraftSchema,
  AnalysisUnitDraftSchema,
  type AgentAnalysisDraft,
} from "./types.js";

/**
 * LOT H — chunked analysis of large allotted markets. Root cause of two prod
 * defects: a mother with many lots (e.g. 48) needs an output that cannot fit
 * in maxOutputTokens=8192, so the LLM either drops units (0 mapped) or gets
 * truncated (zod-invalid, cost paid for nothing). The fix splits the INPUT so
 * the expected output of each call always fits: one framing call (market
 * summary, global watchpoints, full lot roster) then N chunk calls, each
 * required to return exactly the units of its slice.
 */

export const MIN_ANALYZE_UNITS_PER_CALL = 1;
export const MAX_ANALYZE_UNITS_PER_CALL = 20;
export const DEFAULT_ANALYZE_UNITS_PER_CALL = 8;

/** AgentAnalysisDraftSchema caps units at 100: the roster inherits the cap. */
const MAX_ROSTER_SIZE = 100;
const MAX_CHUNK_ATTEMPTS = 2;

export class AnalyzeChunkFailedError extends Error {
  readonly code = "ANALYZE_CHUNK_FAILED";

  constructor(
    /** "framing", a 1-based chunk index, or "assembly". */
    public readonly chunk: string,
    /** Total cost already paid in this run (all calls, including retries). */
    public readonly costUsd: number,
    options?: ErrorOptions,
  ) {
    super(`ANALYZE_CHUNK_FAILED:${chunk}`, options);
    this.name = "AnalyzeChunkFailedError";
  }
}

/** Family key used everywhere lots are matched ("Lot n°01a" → "1A"). */
function lotKey(number: string): string {
  return normalizeLotNumberValue(number) ??
    number.trim().toLocaleLowerCase("fr");
}

export const MarketFramingSchema = z.object({
  marketSummary: z.string().trim().min(1).max(2_000),
  watchpoints: z.array(z.string().trim().min(1).max(2_000)).max(50),
  roster: z.array(z.object({
    number: z.string().trim().min(1).max(32),
    title: z.string().trim().min(1).max(500),
  }).strict()).min(1).max(MAX_ROSTER_SIZE),
}).strict();
export type MarketFraming = z.infer<typeof MarketFramingSchema>;

/**
 * Framing acceptance: unique lot numbers, every document-attested lot number
 * present, and at least as many lots as the reliable roster sources announce
 * (LOT D: DB lot children count, analysis_lot_number of the documents).
 */
function buildFramingSchema(input: {
  requiredLotKeys: ReadonlySet<string>;
  expectedLotCount: number;
}) {
  return MarketFramingSchema.superRefine((value, context) => {
    const keys = value.roster.map((lot) => lotKey(lot.number));
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roster"],
        message: "Roster lot numbers must be unique",
      });
    }
    const covered = new Set(keys);
    for (const required of input.requiredLotKeys) {
      if (!covered.has(required)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roster"],
          message: `Roster misses document-attested lot ${required}`,
        });
      }
    }
    if (value.roster.length < input.expectedLotCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roster"],
        message: `Roster holds ${value.roster.length} lots but at least ` +
          `${input.expectedLotCount} are expected`,
      });
    }
  });
}

/**
 * Chunk acceptance: only lot units, and exactly the lots of the slice — each
 * expected lot once, no foreign or duplicate lot. This is what guarantees the
 * final exhaustivity by construction (slices partition the roster).
 */
export function buildChunkUnitsSchema(lots: readonly AnalyzeRosterLot[]) {
  const expected = new Set(lots.map((lot) => lotKey(lot.number)));
  return z.object({
    units: z.array(AnalysisUnitDraftSchema).min(1).max(lots.length),
  }).strict().superRefine((value, context) => {
    const seen = new Set<string>();
    value.units.forEach((entry, index) => {
      if (entry.unit.kind !== "lot") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["units", index],
          message: "A chunk only carries lot units",
        });
        return;
      }
      const key = lotKey(entry.unit.number);
      if (!expected.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["units", index],
          message: `Lot ${entry.unit.number} does not belong to this chunk`,
        });
        return;
      }
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["units", index],
          message: `Lot ${entry.unit.number} is duplicated in this chunk`,
        });
        return;
      }
      seen.add(key);
    });
    if (seen.size !== expected.size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["units"],
        message: "A chunk must cover every lot of its slice exactly once",
      });
    }
  });
}

export function buildLotChunks(
  roster: readonly AnalyzeRosterLot[],
  unitsPerCall: number,
): AnalyzeRosterLot[][] {
  if (
    !Number.isSafeInteger(unitsPerCall) ||
    unitsPerCall < MIN_ANALYZE_UNITS_PER_CALL ||
    unitsPerCall > MAX_ANALYZE_UNITS_PER_CALL
  ) {
    throw new Error("ANALYZE_UNITS_PER_CALL_INVALID");
  }
  const chunks: AnalyzeRosterLot[][] = [];
  for (let start = 0; start < roster.length; start += unitsPerCall) {
    chunks.push(roster.slice(start, start + unitsPerCall));
  }
  return chunks;
}

/** Lot numbers attested by the assembled documents (analysis_lot_number). */
export function documentLotNumbers(dossier: AnalyzeDossierInput): string[] {
  const byKey = new Map<string, string>();
  for (const document of dossier.documents) {
    if (!document.lotNumber) continue;
    const key = lotKey(document.lotNumber);
    if (!byKey.has(key)) byKey.set(key, document.lotNumber.trim());
  }
  return [...byKey.values()];
}

interface RunTotals {
  costUsd: number;
  usage: AnalyzeUsage;
  stepsUsed: number;
  attempts: number;
}

export interface ChunkedAnalystInput {
  dossier: AnalyzeDossierInput;
  learning: AnalyzeLearningSnapshot;
  client: AgentGenerationClient;
  config: { maxSteps: number; maxOutputTokens: number };
  unitsPerCall: number;
  /** Minimum roster size expected from reliable sources (LOT D). */
  expectedLotCount: number;
  logger?: WorkerLogger;
}

/**
 * One bounded call with the single-call retry discipline (1 repair retry on
 * an invalid structured output). Successful calls are never replayed within
 * the run — the in-run cache is simply the accumulated `parsed` results — so
 * a failing chunk only re-pays itself. Across queue retries (new process),
 * everything is re-paid: accepted trade-off, no durable cache.
 */
async function generateValidated<T>(input: {
  run: ChunkedAnalystInput;
  totals: RunTotals;
  mission: AnalyzeCallMission;
  chunkLabel: string;
  logIndex: number;
  logLots: string[];
  parse: (output: unknown) => T;
}): Promise<T> {
  const startCost = input.totals.costUsd;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
    input.totals.attempts += 1;
    try {
      const generated = await input.run.client.generate({
        dossier: input.run.dossier,
        learning: input.run.learning,
        repair: attempt > 1,
        maxSteps: input.run.config.maxSteps,
        maxOutputTokens: input.run.config.maxOutputTokens,
        mission: input.mission,
      });
      input.totals.costUsd = roundedCost(
        input.totals.costUsd + generated.costUsd,
      );
      input.totals.usage = addUsage(input.totals.usage, generated.usage);
      input.totals.stepsUsed += generated.stepsUsed;
      const parsed = input.parse(generated.output);
      input.run.logger?.info("analyze_chunk", {
        tender_id: input.run.dossier.tender.id,
        index: input.logIndex,
        chunk: input.chunkLabel,
        lots: input.logLots,
        cost_usd: roundedCost(input.totals.costUsd - startCost),
        status: "ok",
        attempts: attempt,
      });
      return parsed;
    } catch (error) {
      if (error instanceof SdkAnalyzeStructuredOutputError) {
        input.totals.costUsd = roundedCost(
          input.totals.costUsd + error.costUsd,
        );
        input.totals.usage = addUsage(input.totals.usage, error.usage);
        input.totals.stepsUsed += error.stepsUsed;
        lastError = error;
        continue;
      }
      if (error instanceof z.ZodError) {
        lastError = error;
        continue;
      }
      // AnalyzeDraftGroundingError carries a `code`; treat any grounding
      // failure of THIS slice as retryable exactly like an invalid output.
      if (
        error instanceof Error && "code" in error &&
        (error as { code?: unknown }).code === "ANALYZE_DRAFT_NOT_GROUNDED"
      ) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  input.run.logger?.info("analyze_chunk", {
    tender_id: input.run.dossier.tender.id,
    index: input.logIndex,
    chunk: input.chunkLabel,
    lots: input.logLots,
    cost_usd: roundedCost(input.totals.costUsd - startCost),
    status: "failed",
    attempts: MAX_CHUNK_ATTEMPTS,
  });
  throw new AnalyzeChunkFailedError(
    input.chunkLabel,
    input.totals.costUsd,
    { cause: lastError },
  );
}

export async function runChunkedDceAnalyst(
  input: ChunkedAnalystInput,
): Promise<DceAnalystResult> {
  const totals: RunTotals = {
    costUsd: 0,
    usage: emptyUsage(),
    stepsUsed: 0,
    attempts: 0,
  };
  const expectedLotNumbers = documentLotNumbers(input.dossier);
  const requiredLotKeys = new Set(expectedLotNumbers.map(lotKey));
  const framingSchema = buildFramingSchema({
    requiredLotKeys,
    expectedLotCount: input.expectedLotCount,
  });

  const framing = await generateValidated({
    run: input,
    totals,
    mission: {
      kind: "framing",
      expectedLotNumbers,
      expectedLotCount: input.expectedLotCount,
    },
    chunkLabel: "framing",
    logIndex: 0,
    logLots: [],
    parse: (output) => framingSchema.parse(output),
  });

  const chunks = buildLotChunks(framing.roster, input.unitsPerCall);
  const framingContext = {
    marketSummary: framing.marketSummary,
    watchpoints: framing.watchpoints,
  };
  const units: AgentAnalysisDraft["units"] = [];
  for (const [index, lots] of chunks.entries()) {
    const chunkSchema = buildChunkUnitsSchema(lots);
    const chunkResult = await generateValidated({
      run: input,
      totals,
      mission: {
        kind: "chunk",
        index: index + 1,
        total: chunks.length,
        lots,
        framing: framingContext,
      },
      chunkLabel: String(index + 1),
      logIndex: index + 1,
      logLots: lots.map((lot) => lot.number),
      parse: (output) => {
        const parsed = chunkSchema.parse(output);
        assertUnitsCitationsGrounded(parsed.units, input.dossier.documents);
        return parsed;
      },
    });
    // Deterministic assembly order: the roster order of the slice, not the
    // arbitrary order the model answered in.
    const byKey = new Map(chunkResult.units.map((entry) => [
      entry.unit.kind === "lot" ? lotKey(entry.unit.number) : "",
      entry,
    ]));
    for (const lot of lots) {
      const entry = byKey.get(lotKey(lot.number));
      if (entry) units.push(entry);
    }
  }

  // Defensive re-validation of the assembled draft: chunk exactness should
  // make failures impossible here, but the write path must never receive a
  // draft that the single-call path would have rejected.
  try {
    const draft = AgentAnalysisDraftSchema.parse({
      marketSummary: framing.marketSummary,
      // The roster was validated against every reliable source (DB children
      // count, document lot numbers) and every roster lot got its unit: the
      // assembly declares the roster complete.
      rosterComplete: true,
      units,
    } satisfies AgentAnalysisDraft);
    assertDraftGrounded(draft, input.dossier);
    return {
      draft,
      attempts: totals.attempts,
      stepsUsed: totals.stepsUsed,
      costUsd: totals.costUsd,
      usage: totals.usage,
    };
  } catch (error) {
    throw new AnalyzeChunkFailedError("assembly", totals.costUsd, {
      cause: error,
    });
  }
}
