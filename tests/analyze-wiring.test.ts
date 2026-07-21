import { describe, expect, it, vi } from "vitest";

import type {
  AgentGenerationClient,
  AnalyzeConfig,
  AnalyzeLearningSnapshot,
  AnalysisResultSink,
} from "../src/analyze/index.js";
import {
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
  marketSummary: "Marché de rénovation alloti.",
  units: [{
    unit: { kind: "lot" as const, number: "1", title: "Rénovation" },
    proposedVerdict: "favorable" as const,
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
    deadlineMinDays: 15,
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
});
