import { describe, expect, it, vi } from "vitest";

import type {
  AgentGenerationClient,
  AnalyzeConfig,
  AnalyzeLearningSnapshot,
  AnalysisResultSink,
} from "../src/analyze/index.js";
import {
  buildLastError,
  codeOf,
  runAnalyzeOneShot,
  type AnalyzeApplyStore,
  type AnalyzeDossierAssembly,
  type AnalyzeReadStore,
} from "../src/analyze/wiring.js";

const assembly: AnalyzeDossierAssembly = {
  queue: { queueId: "queue-1", tenderId: "tender-1", attempts: 0 },
  companyId: "company-1",
  recordType: "market",
  lot: null,
  autoMaterializeLots: false,
  existingLotCount: 0,
  existingScore: 72,
  deadlineDate: null,
  coverage: {
    complete: true,
    documentsCount: 1,
    omittedDocuments: 0,
    totalCharacters: 48,
  },
  dossier: {
    tender: {
      id: "tender-1",
      title: "Marché de rénovation",
      buyerName: "Ville test",
      description: "Rénovation d'un bâtiment communal",
      location: "Paris 75",
      estimatedAmount: 500_000,
      procedureType: "MAPA",
    },
    company: {
      name: "Entreprise test",
      core_business: "Rénovation",
      certifications_held: [],
    },
    mandatoryQualifications: [],
    documents: [{
      id: "doc-1",
      fileName: "CCTP.pdf",
      role: "cctp",
      lotNumber: "1",
      text: "Travaux de rénovation du bâtiment communal.",
    }],
  },
};

const learning: AnalyzeLearningSnapshot = {
  lessons: [{
    id: "lesson-1",
    kind: "go",
    tenderRef: "AO-OLD",
    title: "Marché proche",
    lessonText: "Bon fit métier",
    decidedAt: "2026-07-01T00:00:00.000Z",
    similarity: 0.91,
  }],
  rules: [],
  context: "Marché proche: bon fit métier",
};

const agentOutput = {
  rosterComplete: true,
  marketSummary: "Marché de rénovation alloti.",
  units: [{
    unit: { kind: "lot" as const, number: "1", title: "Rénovation" },
    proposedVerdict: "favorable" as const,
    businessFields: null,
    rationale: "Le lot correspond exactement au métier.",
    criteria: {
      metier: 30,
      geo: 20,
      montant: 20,
      procedure: 15,
      certifications: 0,
    },
    unknownCriteria: ["certifications" as const],
    summary: {
      scope: "Rénovation du bâtiment communal.",
      services: ["Travaux de rénovation"],
      requirements: ["Respect du CCTP"],
      qualifications: [],
      amounts: ["500 000 euros"],
      watchpoints: ["Calendrier à confirmer"],
    },
    requiredQualifications: [],
    socialInsertion: null,
    citations: [{ documentId: "doc-1", excerpt: "Travaux de rénovation" }],
  }],
};

function config(mode: AnalyzeConfig["mode"]): AnalyzeConfig {
  return {
    mode,
    model: "openai/gpt-5.6-terra",
    maxSteps: 8,
    maxOutputTokens: 8_192,
    unitsPerCall: 8,
    deadlineMinDays: 15,
    recordTypes: ["standalone"],
    openRouterApiKey: mode === "off" ? undefined : "test",
  };
}

function generationClient(): AgentGenerationClient {
  return {
    generate: vi.fn().mockResolvedValue({
      output: agentOutput,
      stepsUsed: 3,
      costUsd: 0.03,
      usage: { inputTokens: 1_000, outputTokens: 400, totalTokens: 1_400 },
    }),
  };
}

function readStore(overrides: Partial<AnalyzeReadStore> = {}): AnalyzeReadStore {
  return {
    peekCandidates: vi.fn().mockResolvedValue([assembly.queue]),
    assembleCandidate: vi.fn().mockResolvedValue({
      status: "ready",
      assembly,
    }),
    readCurrentScore: vi.fn().mockResolvedValue(72),
    ...overrides,
  };
}

function applyStore(sink: AnalysisResultSink): AnalyzeApplyStore {
  return {
    claim: vi.fn().mockResolvedValue("claimed"),
    createResultSink: vi.fn(() => sink),
    markDone: vi.fn().mockResolvedValue(undefined),
    markPending: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runAnalyzeOneShot", () => {
  it("returns off without requiring or constructing dependencies", async () => {
    await expect(runAnalyzeOneShot(config("off"))).resolves.toEqual({
      mode: "off",
      status: "off",
    });
  });

  it("analyzes and compares in shadow without invoking any write capability", async () => {
    const sink = { write: vi.fn() } satisfies AnalysisResultSink;
    const writes = applyStore(sink);
    const recordLearningUsage = vi.fn();
    const logger = { info: vi.fn() };

    const report = await runAnalyzeOneShot(config("shadow"), {
      readStore: readStore(),
      applyStore: writes,
      client: generationClient(),
      recallLearning: vi.fn().mockResolvedValue(learning),
      recordLearningUsage,
      logger,
    }, { now: () => new Date("2026-07-20T20:00:00.000Z") });

    expect(report).toMatchObject({
      mode: "shadow",
      status: "analyzed",
      queueId: "queue-1",
      tenderId: "tender-1",
      existingScore: 72,
      analyzedScore: 100,
      delta: 28,
    });
    expect(writes.claim).not.toHaveBeenCalled();
    expect(writes.createResultSink).not.toHaveBeenCalled();
    expect(writes.markDone).not.toHaveBeenCalled();
    expect(writes.markPending).not.toHaveBeenCalled();
    expect(writes.markFailed).not.toHaveBeenCalled();
    expect(sink.write).not.toHaveBeenCalled();
    expect(recordLearningUsage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_shadow_comparison",
      expect.objectContaining({
        existing_score: 72,
        shadow_score: 100,
        delta: 28,
        learning_applied: true,
        lessons_count: 1,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_shadow_unit",
      expect.objectContaining({
        queue_id: "queue-1",
        summary: expect.objectContaining({
          scope: "Rénovation du bâtiment communal.",
        }),
      }),
    );
  });

  it("claims once in apply, assembles, writes, then completes the queue row", async () => {
    const sink = { write: vi.fn().mockResolvedValue(undefined) };
    const writes = applyStore(sink);
    const reads = readStore();

    const report = await runAnalyzeOneShot(config("apply"), {
      readStore: reads,
      applyStore: writes,
      client: generationClient(),
      recallLearning: vi.fn().mockResolvedValue(learning),
      recordLearningUsage: vi.fn().mockResolvedValue(undefined),
    }, { now: () => new Date("2026-07-20T20:00:00.000Z") });

    expect(report).toMatchObject({
      mode: "apply",
      status: "analyzed",
      queueId: "queue-1",
      tenderId: "tender-1",
    });
    expect(writes.claim).toHaveBeenCalledOnce();
    expect(reads.assembleCandidate).toHaveBeenCalledOnce();
    expect(sink.write).toHaveBeenCalledOnce();
    expect(writes.markDone).toHaveBeenCalledWith(
      "queue-1",
      "2026-07-20T20:00:00.000Z",
    );
  });

  it("forwards the direct lot context from the assembly to the written payload", async () => {
    const sink = { write: vi.fn().mockResolvedValue(undefined) };
    const writes = applyStore(sink);
    const lotAssembly: AnalyzeDossierAssembly = {
      ...assembly,
      recordType: "lot",
      lot: {
        parentTenderId: "parent-1",
        number: "1",
        title: "Rénovation",
        sourceLotKey: "boamp:lot-1",
      },
    };

    const report = await runAnalyzeOneShot(config("apply"), {
      readStore: readStore({
        assembleCandidate: vi.fn().mockResolvedValue({
          status: "ready",
          assembly: lotAssembly,
        }),
      }),
      applyStore: writes,
      client: generationClient(),
      recallLearning: vi.fn().mockResolvedValue(learning),
    }, { now: () => new Date("2026-07-20T20:00:00.000Z") });

    expect(report).toMatchObject({ mode: "apply", status: "analyzed" });
    expect(writes.createResultSink).toHaveBeenCalledWith(lotAssembly);
    expect(sink.write).toHaveBeenCalledWith(expect.objectContaining({
      lots: [expect.objectContaining({
        sourceLotKey: "boamp:lot-1",
        number: "1",
        relevanceScore: 100,
      })],
    }));
    const payload = sink.write.mock.calls[0]?.[0] as {
      tenderValues: Record<string, unknown>;
    };
    expect(payload.tenderValues).not.toHaveProperty("relevance_score");
  });

  it("does not expose provider error bodies in operational issues", async () => {
    const logger = { info: vi.fn() };
    const report = await runAnalyzeOneShot(config("shadow"), {
      readStore: readStore(),
      client: {
        generate: vi.fn().mockRejectedValue(
          new Error("https://provider.example/error?token=secret"),
        ),
      },
      recallLearning: vi.fn().mockResolvedValue(learning),
      logger,
    });

    expect(report).toMatchObject({
      status: "failed",
      issue: "ANALYZE_FAILED",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_one_shot_failed",
      expect.objectContaining({ issue: "ANALYZE_FAILED" }),
    );
  });

  it("persists the error detail through markFailed and logs analyze_error_detail", async () => {
    const sink = { write: vi.fn() } satisfies AnalysisResultSink;
    const writes = applyStore(sink);
    const logger = { info: vi.fn() };
    const providerError = new Error("Bad gateway from provider upstream");
    providerError.name = "AI_APICallError";

    const report = await runAnalyzeOneShot(config("apply"), {
      readStore: readStore(),
      applyStore: writes,
      client: { generate: vi.fn().mockRejectedValue(providerError) },
      recallLearning: vi.fn().mockResolvedValue(learning),
      logger,
    });

    expect(report).toMatchObject({
      mode: "apply",
      status: "failed",
      issue: "ANALYZE_FAILED",
    });
    expect(writes.markFailed).toHaveBeenCalledWith(
      "queue-1",
      1,
      "ANALYZE_FAILED: AI_APICallError: Bad gateway from provider upstream",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_error_detail",
      expect.objectContaining({
        queue_id: "queue-1",
        tender_id: "tender-1",
        code: "ANALYZE_FAILED",
        name: "AI_APICallError",
        message: "Bad gateway from provider upstream",
        stack_head: expect.stringContaining("AI_APICallError"),
      }),
    );
    const detailRecord = logger.info.mock.calls.find(
      (call) => call[0] === "analyze_error_detail",
    )?.[1] as { stack_head: string };
    expect(detailRecord.stack_head.split("\n").length).toBeLessThanOrEqual(3);
    expect(logger.info).not.toHaveBeenCalledWith(
      "analyze_row_terminal",
      expect.anything(),
    );
  });

  it("logs analyze_row_terminal when markFailed reaches the attempts cap", async () => {
    const sink = { write: vi.fn() } satisfies AnalysisResultSink;
    const writes = applyStore(sink);
    const logger = { info: vi.fn() };
    const terminalCandidate = { queueId: "queue-9", tenderId: "tender-9", attempts: 2 };

    await runAnalyzeOneShot(config("apply"), {
      readStore: readStore({
        peekCandidates: vi.fn().mockResolvedValue([terminalCandidate]),
        assembleCandidate: vi.fn().mockResolvedValue({
          status: "ready",
          assembly: { ...assembly, queue: terminalCandidate },
        }),
      }),
      applyStore: writes,
      client: { generate: vi.fn().mockRejectedValue(new Error("provider down")) },
      recallLearning: vi.fn().mockResolvedValue(learning),
      logger,
    });

    expect(writes.markFailed).toHaveBeenCalledWith(
      "queue-9",
      3,
      "ANALYZE_FAILED: provider down",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_row_terminal",
      expect.objectContaining({
        queue_id: "queue-9",
        tender_id: "tender-9",
        attempts: 3,
        code: "ANALYZE_FAILED",
      }),
    );
  });
});

describe("codeOf", () => {
  it("prefers an uppercase code property", () => {
    const error = Object.assign(new Error("rich message"), { code: "AGENT_STEP_LIMIT" });
    expect(codeOf(error)).toBe("AGENT_STEP_LIMIT");
  });

  it("uses the message when it already is a code", () => {
    expect(codeOf(new Error("ANALYZE_QUEUE_READ_FAILED"))).toBe("ANALYZE_QUEUE_READ_FAILED");
  });

  it("falls back to ANALYZE_FAILED for rich messages", () => {
    expect(codeOf(new Error("provider exploded"))).toBe("ANALYZE_FAILED");
  });
});

describe("buildLastError", () => {
  it("appends the rich message after the code", () => {
    expect(buildLastError(new Error("provider exploded"))).toBe(
      "ANALYZE_FAILED: provider exploded",
    );
  });

  it("keeps a code-only message unchanged", () => {
    expect(buildLastError(new Error("ANALYZE_SERVICE_DID_NOT_ANALYZE"))).toBe(
      "ANALYZE_SERVICE_DID_NOT_ANALYZE",
    );
  });

  it("includes the SDK error name", () => {
    const error = new Error("429 rate limited");
    error.name = "AI_APICallError";
    expect(buildLastError(error)).toBe("ANALYZE_FAILED: AI_APICallError: 429 rate limited");
  });

  it("truncates long messages to about 300 characters", () => {
    const long = "x".repeat(1_000);
    const built = buildLastError(new Error(long));
    expect(built.startsWith("ANALYZE_FAILED: ")).toBe(true);
    expect(built.length).toBeLessThanOrEqual("ANALYZE_FAILED: ".length + 301);
    expect(built.endsWith("…")).toBe(true);
  });

  it("keeps the bare code for typed guard errors whose message is the code", () => {
    const error = new Error("ANALYZE_LOT_SYNC_UNMATCHED");
    error.name = "AnalyzeLotSyncUnmatchedError";
    expect(buildLastError(error)).toBe("ANALYZE_LOT_SYNC_UNMATCHED");
  });

  it("returns the bare code when the error has no message", () => {
    expect(buildLastError(new Error(""))).toBe("ANALYZE_FAILED");
  });

  it("stringifies non-Error values", () => {
    expect(buildLastError("boom string")).toBe("ANALYZE_FAILED: boom string");
  });

  it("redacts URL query strings so tokens never reach last_error", () => {
    const built = buildLastError(
      new Error("fetch failed https://provider.example/error?token=secret123"),
    );
    expect(built).not.toContain("secret123");
    expect(built).toContain("https://provider.example/error?[REDACTED]");
  });
});
