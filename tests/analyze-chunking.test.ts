import { describe, expect, it, vi } from "vitest";

import {
  AnalyzeChunkFailedError,
  buildLotChunks,
  createOpenRouterDceAnalystClient,
  loadAnalyzeConfig,
  runAnalyzeService,
  runChunkedDceAnalyst,
  type AgentGenerationClient,
  type AgentGenerationRequest,
  type AnalyzeConfig,
  type AnalyzeDossierInput,
  type AnalyzeLearningSnapshot,
  type AnalysisResultSink,
} from "../src/analyze/index.js";

const learning: AnalyzeLearningSnapshot = {
  lessons: [],
  rules: [],
  context: "",
};

function dossierWithLots(lotNumbers: string[]): AnalyzeDossierInput {
  return {
    tender: {
      id: "tender-48",
      title: "Marché alloti géant",
      buyerName: "Ville test",
      description: "Beaucoup de lots",
      location: "75",
      estimatedAmount: 4_000_000,
      procedureType: "AO ouvert",
    },
    company: {
      name: "Entreprise test",
      core_business: "Tous corps d'état",
      certifications_held: [],
      accepts_social_insertion: true,
    },
    mandatoryQualifications: [],
    documents: [
      {
        id: "rc-1",
        fileName: "RC.pdf",
        role: "rc",
        lotNumber: null,
        text: "Règlement de consultation listant tous les lots.",
      },
      ...lotNumbers.map((number) => ({
        id: `cctp-${number}`,
        fileName: `CCTP lot ${number}.pdf`,
        role: "cctp" as const,
        lotNumber: number,
        text: `Lot ${number} description.`,
      })),
    ],
  };
}

function lotNumbers(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(index + 1));
}

function unit(number: string, title: string) {
  return {
    unit: { kind: "lot" as const, number, title },
    proposedVerdict: "favorable" as const,
    businessFields: null,
    rationale: `Le lot ${number} est adapté.`,
    criteria: {
      metier: 20,
      geo: 20,
      montant: 20,
      procedure: 15,
      certifications: 0,
    },
    unknownCriteria: ["certifications" as const],
    summary: {
      scope: `Périmètre du lot ${number}`,
      services: [`Prestations du lot ${number}`],
      requirements: [],
      qualifications: [],
      amounts: [],
      watchpoints: [],
    },
    requiredQualifications: [],
    socialInsertion: null,
    citations: [{ documentId: "rc-1", excerpt: `Lot ${number}` }],
  };
}

function framingOutput(numbers: string[]) {
  return {
    marketSummary: "Marché alloti de grande ampleur.",
    watchpoints: ["Visite obligatoire"],
    roster: numbers.map((number) => ({
      number,
      title: `Lot ${number} corps d'état`,
    })),
  };
}

interface ChunkedClientOptions {
  framing?: unknown;
  chunkOutput?: (
    lots: { number: string; title: string }[],
    request: AgentGenerationRequest,
  ) => unknown;
}

function chunkedClient(numbers: string[], options: ChunkedClientOptions = {}) {
  const generate = vi.fn(async (request: AgentGenerationRequest) => {
    const mission = request.mission;
    if (!mission) throw new Error("unexpected full-dossier call");
    if (mission.kind === "framing") {
      return {
        output: options.framing ?? framingOutput(numbers),
        stepsUsed: 1,
        costUsd: 0.01,
        usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
      };
    }
    const output = options.chunkOutput
      ? options.chunkOutput(mission.lots, request)
      : { units: mission.lots.map((lot) => unit(lot.number, lot.title)) };
    return {
      output,
      stepsUsed: 2,
      costUsd: 0.02,
      usage: { inputTokens: 2_000, outputTokens: 800, totalTokens: 2_800 },
    };
  });
  return { client: { generate } satisfies AgentGenerationClient, generate };
}

const runConfig = { maxSteps: 8, maxOutputTokens: 8_192 };

describe("buildLotChunks", () => {
  it("slices a 48-lot roster into 6 chunks of 8, order preserved", () => {
    const roster = lotNumbers(48).map((number) => ({
      number,
      title: `Lot ${number}`,
    }));
    const chunks = buildLotChunks(roster, 8);
    expect(chunks).toHaveLength(6);
    expect(chunks.every((chunk) => chunk.length === 8)).toBe(true);
    expect(chunks.flat()).toEqual(roster);
  });

  it("keeps a trailing partial chunk", () => {
    const roster = lotNumbers(10).map((number) => ({
      number,
      title: `Lot ${number}`,
    }));
    const chunks = buildLotChunks(roster, 4);
    expect(chunks.map((chunk) => chunk.length)).toEqual([4, 4, 2]);
  });
});

describe("runChunkedDceAnalyst", () => {
  it("frames then analyzes 48 lots in 6 chunks and assembles every unit once", async () => {
    const numbers = lotNumbers(48);
    const { client, generate } = chunkedClient(numbers);
    const logger = { info: vi.fn() };

    const result = await runChunkedDceAnalyst({
      dossier: dossierWithLots(numbers),
      learning,
      client,
      config: runConfig,
      unitsPerCall: 8,
      expectedLotCount: 48,
      logger,
    });

    expect(generate).toHaveBeenCalledTimes(7);
    expect(result.draft.units).toHaveLength(48);
    expect(result.draft.rosterComplete).toBe(true);
    expect(result.draft.marketSummary).toBe("Marché alloti de grande ampleur.");
    expect(
      result.draft.units.map((entry) =>
        entry.unit.kind === "lot" ? entry.unit.number : null
      ),
    ).toEqual(numbers);
    // 1 framing (0.01) + 6 chunks (0.02) = 0.13, usage summed the same way.
    expect(result.costUsd).toBeCloseTo(0.13, 10);
    expect(result.usage).toEqual({
      inputTokens: 1_000 + 6 * 2_000,
      outputTokens: 200 + 6 * 800,
      totalTokens: 1_200 + 6 * 2_800,
    });
    expect(result.stepsUsed).toBe(1 + 6 * 2);
    expect(result.attempts).toBe(7);
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_chunk",
      expect.objectContaining({ index: 0, lots: [], status: "ok" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_chunk",
      expect.objectContaining({
        index: 6,
        lots: ["41", "42", "43", "44", "45", "46", "47", "48"],
        status: "ok",
        cost_usd: 0.02,
      }),
    );
  });

  it("passes the condensed market context and repair flag to chunk calls", async () => {
    const numbers = lotNumbers(9);
    const { client, generate } = chunkedClient(numbers);

    await runChunkedDceAnalyst({
      dossier: dossierWithLots(numbers),
      learning,
      client,
      config: runConfig,
      unitsPerCall: 8,
      expectedLotCount: 9,
    });

    const chunkCall = generate.mock.calls[1]?.[0];
    expect(chunkCall?.mission).toMatchObject({
      kind: "chunk",
      index: 1,
      total: 2,
      framing: {
        marketSummary: "Marché alloti de grande ampleur.",
        watchpoints: ["Visite obligatoire"],
      },
    });
    expect(chunkCall?.repair).toBe(false);
    expect(chunkCall?.maxOutputTokens).toBe(8_192);
  });

  it("retries once a chunk missing a lot, then fails typed without further calls", async () => {
    const numbers = lotNumbers(16);
    const { client, generate } = chunkedClient(numbers, {
      chunkOutput: (lots, request) => {
        const mission = request.mission;
        if (mission?.kind === "chunk" && mission.index === 2) {
          // Always drop the last expected lot of chunk 2.
          return {
            units: lots.slice(0, -1).map((lot) => unit(lot.number, lot.title)),
          };
        }
        return { units: lots.map((lot) => unit(lot.number, lot.title)) };
      },
    });
    const logger = { info: vi.fn() };

    const promise = runChunkedDceAnalyst({
      dossier: dossierWithLots(numbers),
      learning,
      client,
      config: runConfig,
      unitsPerCall: 8,
      expectedLotCount: 16,
      logger,
    });

    await expect(promise).rejects.toBeInstanceOf(AnalyzeChunkFailedError);
    const error = await promise.catch((caught: unknown) => caught) as
      AnalyzeChunkFailedError;
    expect(error.code).toBe("ANALYZE_CHUNK_FAILED");
    expect(error.message).toBe("ANALYZE_CHUNK_FAILED:2");
    // framing + chunk 1 + chunk 2 twice (1 retry) = 4 calls, nothing after.
    expect(generate).toHaveBeenCalledTimes(4);
    const retryCall = generate.mock.calls[3]?.[0];
    expect(retryCall?.repair).toBe(true);
    // Cost of every paid call is reported: 0.01 + 3 * 0.02.
    expect(error.costUsd).toBeCloseTo(0.07, 10);
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_chunk",
      expect.objectContaining({ index: 2, status: "failed", attempts: 2 }),
    );
  });

  it("rejects a chunk answering with a lot from another chunk", async () => {
    const numbers = lotNumbers(16);
    const { client } = chunkedClient(numbers, {
      chunkOutput: (lots, request) => {
        const mission = request.mission;
        if (mission?.kind === "chunk" && mission.index === 1) {
          const units = lots.map((lot) => unit(lot.number, lot.title));
          units[0] = unit("16", "Lot 16 corps d'état");
          return { units };
        }
        return { units: lots.map((lot) => unit(lot.number, lot.title)) };
      },
    });

    await expect(runChunkedDceAnalyst({
      dossier: dossierWithLots(numbers),
      learning,
      client,
      config: runConfig,
      unitsPerCall: 8,
      expectedLotCount: 16,
    })).rejects.toMatchObject({ message: "ANALYZE_CHUNK_FAILED:1" });
  });

  it("rejects a chunk unit citing an unknown document", async () => {
    const numbers = lotNumbers(9);
    const { client } = chunkedClient(numbers, {
      chunkOutput: (lots, request) => {
        const mission = request.mission;
        if (mission?.kind === "chunk" && mission.index === 2) {
          return {
            units: lots.map((lot) => ({
              ...unit(lot.number, lot.title),
              citations: [{ documentId: "ghost-doc", excerpt: "invent" }],
            })),
          };
        }
        return { units: lots.map((lot) => unit(lot.number, lot.title)) };
      },
    });

    await expect(runChunkedDceAnalyst({
      dossier: dossierWithLots(numbers),
      learning,
      client,
      config: runConfig,
      unitsPerCall: 8,
      expectedLotCount: 9,
    })).rejects.toMatchObject({ message: "ANALYZE_CHUNK_FAILED:2" });
  });

  it("retries the framing when the roster misses a document-attested lot", async () => {
    const numbers = lotNumbers(12);
    const { client, generate } = chunkedClient(numbers, {
      framing: framingOutput(numbers.slice(0, 10)),
    });

    await expect(runChunkedDceAnalyst({
      dossier: dossierWithLots(numbers),
      learning,
      client,
      config: runConfig,
      unitsPerCall: 8,
      expectedLotCount: 12,
    })).rejects.toMatchObject({ message: "ANALYZE_CHUNK_FAILED:framing" });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("retries the framing when the roster is below the DB lot count", async () => {
    const numbers = lotNumbers(4);
    const { client } = chunkedClient(numbers);

    await expect(runChunkedDceAnalyst({
      dossier: dossierWithLots(numbers),
      learning,
      client,
      config: runConfig,
      unitsPerCall: 2,
      // The DB already holds 6 lot children: a 4-lot roster is incomplete.
      expectedLotCount: 6,
    })).rejects.toMatchObject({ message: "ANALYZE_CHUNK_FAILED:framing" });
  });
});

describe("runAnalyzeService chunked dispatch", () => {
  function config(mode: "shadow" | "apply", unitsPerCall = 8): AnalyzeConfig {
    return {
      mode,
      model: "openai/gpt-5.6-terra",
      maxSteps: 8,
      maxOutputTokens: 8_192,
      deadlineMinDays: 15,
      recordTypes: ["market"],
      unitsPerCall,
      openRouterApiKey: "test",
    };
  }

  it("keeps the single-call path unchanged for a small market", async () => {
    const numbers = lotNumbers(2);
    const generate = vi.fn().mockResolvedValue({
      output: {
        rosterComplete: true,
        marketSummary: "Petit marché.",
        units: numbers.map((number) => unit(number, `Lot ${number}`)),
      },
      stepsUsed: 3,
      costUsd: 0.04,
      usage: { inputTokens: 2_000, outputTokens: 900, totalTokens: 2_900 },
    });

    const report = await runAnalyzeService({
      config: config("shadow"),
      dossier: dossierWithLots(numbers),
      client: { generate },
      recallLearning: vi.fn().mockResolvedValue(learning),
      expectedLotCount: 2,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]?.mission).toBeUndefined();
    expect(report.status).toBe("analyzed");
    if (report.status !== "analyzed") throw new Error("expected analyzed");
    expect(report.result.costUsd).toBe(0.04);
  });

  it("dispatches a large mother to the chunked path and sums costs in the write", async () => {
    const numbers = lotNumbers(48);
    const { client, generate } = chunkedClient(numbers);
    const sink: AnalysisResultSink = { write: vi.fn().mockResolvedValue(undefined) };

    const report = await runAnalyzeService({
      config: config("apply"),
      dossier: dossierWithLots(numbers),
      client,
      recallLearning: vi.fn().mockResolvedValue(learning),
      sink,
      expectedLotCount: 48,
      now: () => new Date("2026-07-21T08:00:00.000Z"),
    });

    expect(generate).toHaveBeenCalledTimes(7);
    expect(report.status).toBe("analyzed");
    if (report.status !== "analyzed") throw new Error("expected analyzed");
    expect(report.result.units).toHaveLength(48);
    expect(report.result.costUsd).toBeCloseTo(0.13, 10);
    expect(sink.write).toHaveBeenCalledTimes(1);
    const payload = (sink.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(payload.lots).toHaveLength(48);
    expect(payload.ledger.costUsd).toBeCloseTo(0.13, 10);
    expect(payload.rosterComplete).toBe(true);
  });

  it("fails typed without any write when a chunk stays invalid", async () => {
    const numbers = lotNumbers(48);
    const { client } = chunkedClient(numbers, {
      chunkOutput: (lots, request) => {
        const mission = request.mission;
        if (mission?.kind === "chunk" && mission.index === 3) {
          return { units: [] };
        }
        return { units: lots.map((lot) => unit(lot.number, lot.title)) };
      },
    });
    const sink: AnalysisResultSink = { write: vi.fn() };

    await expect(runAnalyzeService({
      config: config("apply"),
      dossier: dossierWithLots(numbers),
      client,
      recallLearning: vi.fn().mockResolvedValue(learning),
      sink,
      expectedLotCount: 48,
    })).rejects.toMatchObject({
      code: "ANALYZE_CHUNK_FAILED",
      message: "ANALYZE_CHUNK_FAILED:3",
    });
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("never chunks a direct-lot analysis, whatever the roster size", async () => {
    const numbers = lotNumbers(48);
    const generate = vi.fn().mockResolvedValue({
      output: {
        rosterComplete: true,
        marketSummary: "Analyse du lot cible.",
        units: numbers.map((number) => unit(number, `Lot ${number}`)),
      },
      stepsUsed: 3,
      costUsd: 0.05,
      usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
    });

    const report = await runAnalyzeService({
      config: config("shadow"),
      dossier: {
        ...dossierWithLots(numbers),
        targetLot: { number: "7", title: "Lot 7" },
      },
      lot: {
        parentTenderId: "mother-1",
        number: "7",
        title: "Lot 7",
        sourceLotKey: null,
      },
      client: { generate },
      recallLearning: vi.fn().mockResolvedValue(learning),
      expectedLotCount: 48,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]?.mission).toBeUndefined();
    expect(report.status).toBe("analyzed");
  });
});

describe("createOpenRouterDceAnalystClient missions", () => {
  function sdkClientWith(output: unknown) {
    const generateText = vi.fn().mockResolvedValue({
      output,
      steps: [{}],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      providerMetadata: { openrouter: { usage: { cost: 0.002 } } },
    });
    const client = createOpenRouterDceAnalystClient({
      apiKey: "test-key",
      model: "openai/gpt-5.6-terra",
      languageModel: "mock-model",
      generateText,
    });
    return { client, generateText };
  }

  it("builds a framing prompt carrying the attested lot numbers", async () => {
    const numbers = lotNumbers(12);
    const { client, generateText } = sdkClientWith(framingOutput(numbers));

    await client.generate({
      dossier: dossierWithLots(numbers),
      learning,
      repair: false,
      maxSteps: 8,
      maxOutputTokens: 8_192,
      mission: {
        kind: "framing",
        expectedLotNumbers: numbers,
        expectedLotCount: 12,
      },
    });

    const options = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(options.system)).toContain("CADRAGE");
    expect(String(options.system)).not.toContain("rosterComplete");
    expect(String(options.prompt)).toContain("CADRAGE DEMANDÉ:");
    expect(String(options.prompt)).toContain('"expectedLotCount":12');
  });

  it("builds a chunk prompt restricted to the slice with the market context", async () => {
    const numbers = lotNumbers(12);
    const lots = numbers.slice(0, 8).map((number) => ({
      number,
      title: `Lot ${number} corps d'état`,
    }));
    const { client, generateText } = sdkClientWith({
      units: lots.map((lot) => unit(lot.number, lot.title)),
    });

    await client.generate({
      dossier: dossierWithLots(numbers),
      learning,
      repair: false,
      maxSteps: 8,
      maxOutputTokens: 8_192,
      mission: {
        kind: "chunk",
        index: 1,
        total: 2,
        lots,
        framing: {
          marketSummary: "Marché alloti de grande ampleur.",
          watchpoints: ["Visite obligatoire"],
        },
      },
    });

    const options = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(options.system)).toContain("TRANCHE");
    expect(String(options.prompt)).toContain("LOTS DE LA TRANCHE (1/2):");
    expect(String(options.prompt)).toContain("Marché alloti de grande ampleur.");
    expect(String(options.prompt)).toContain("Visite obligatoire");
  });
});

describe("loadAnalyzeConfig unitsPerCall", () => {
  const baseEnv = { ANALYZE_MODE: "shadow", OPENROUTER_API_KEY: "key" };

  it("defaults to 8 lots per call", () => {
    expect(loadAnalyzeConfig(baseEnv).unitsPerCall).toBe(8);
  });

  it("accepts a bounded override", () => {
    expect(
      loadAnalyzeConfig({ ...baseEnv, ANALYZE_UNITS_PER_CALL: "12" })
        .unitsPerCall,
    ).toBe(12);
  });

  it.each(["0", "21", "abc", "3.5"])("rejects %s", (rawValue) => {
    expect(() =>
      loadAnalyzeConfig({ ...baseEnv, ANALYZE_UNITS_PER_CALL: rawValue })
    ).toThrow(/ANALYZE_UNITS_PER_CALL/);
  });
});
