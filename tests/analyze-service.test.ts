import { describe, expect, it, vi } from "vitest";

import {
  AnalyzeApplySinkRequiredError,
  runAnalyzeService,
  type AgentGenerationClient,
  type AnalyzeConfig,
  type AnalyzeDossierInput,
  type AnalyzeLearningSnapshot,
  type AnalysisResultSink,
} from "../src/analyze/index.js";

const dossier: AnalyzeDossierInput = {
  tender: {
    id: "tender-1",
    title: "Marché alloti de rénovation",
    buyerName: "Ville test",
    description: "Deux corps d'état",
    location: "75",
    estimatedAmount: 600_000,
    procedureType: "MAPA",
  },
  company: {
    name: "Entreprise test",
    core_business: "Gros œuvre et électricité",
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
      text: "Le marché comporte deux lots.",
    },
    {
      id: "cctp-1",
      fileName: "CCTP lot 1.pdf",
      role: "cctp",
      lotNumber: "1",
      text: "Lot 1 gros œuvre.",
    },
    {
      id: "cctp-2",
      fileName: "CCTP lot 2.pdf",
      role: "cctp",
      lotNumber: "2",
      text: "Lot 2 électricité.",
    },
  ],
};

const learning: AnalyzeLearningSnapshot = {
  lessons: [{
    id: "lesson-1",
    kind: "go",
    tenderRef: "OLD",
    title: "Marché proche gagné",
    lessonText: "Raison: lot gros œuvre adapté",
    decidedAt: "2026-07-01T00:00:00.000Z",
    similarity: 0.88,
  }],
  rules: [{
    id: "rule-1",
    title: "Règle client",
    description: "Préférer le gros œuvre.",
    recommendedAction: null,
    patternType: "preference",
    confidence: "high",
  }],
  context: "Marché proche gagné → GO",
};

function unit(number: string, title: string, metier: number) {
  return {
    unit: { kind: "lot" as const, number, title },
    proposedVerdict: "favorable" as const,
    rationale: "Le lot " + number + " est adapté.",
    criteria: {
      metier,
      geo: 20,
      montant: 20,
      procedure: 15,
      certifications: 0,
    },
    unknownCriteria: ["certifications" as const],
    summary: {
      scope: "Périmètre détaillé du lot " + number,
      services: ["Prestations du lot " + number],
      requirements: ["Exigences du lot " + number],
      qualifications: [],
      amounts: ["Montant du lot " + number],
      watchpoints: ["Vigilance du lot " + number],
    },
    requiredQualifications: [],
    socialInsertion: null,
    citations: [{ documentId: "cctp-" + number, excerpt: "Lot " + number }],
  };
}

const agentOutput = {
  marketSummary: "Marché de rénovation en deux lots.",
  units: [
    unit("1", "Gros œuvre", 30),
    unit("2", "Électricité", 18),
  ],
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

function client(): AgentGenerationClient {
  return {
    generate: vi.fn().mockResolvedValue({
      output: agentOutput,
      stepsUsed: 4,
      costUsd: 0.04,
      usage: { inputTokens: 2_000, outputTokens: 900, totalTokens: 2_900 },
    }),
  };
}

describe("runAnalyzeService", () => {
  it("does absolutely nothing in off mode", async () => {
    const generate = vi.fn();
    const recallLearning = vi.fn();
    const sink: AnalysisResultSink = { write: vi.fn() };

    await expect(
      runAnalyzeService({
        config: config("off"),
        dossier,
        client: { generate },
        recallLearning,
        sink,
      }),
    ).resolves.toEqual({ mode: "off", status: "off" });
    expect(generate).not.toHaveBeenCalled();
    expect(recallLearning).not.toHaveBeenCalled();
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("analyzes and logs in shadow with zero write", async () => {
    const sink: AnalysisResultSink = { write: vi.fn() };
    const recordLearningUsage = vi.fn();
    const logger = { info: vi.fn() };

    const report = await runAnalyzeService({
      config: config("shadow"),
      dossier,
      client: client(),
      recallLearning: vi.fn().mockResolvedValue(learning),
      sink,
      recordLearningUsage,
      logger,
      now: () => new Date("2026-07-20T20:00:00.000Z"),
    });

    expect(report).toMatchObject({
      mode: "shadow",
      status: "analyzed",
      result: {
        score: 100,
        recommendedLot: { number: "1", title: "Gros œuvre" },
        learning: {
          lessons_count: 1,
          rules_count: 1,
          learning_applied: true,
        },
        execution: {
          attempts: 1,
          steps_used: 4,
          max_steps: 8,
          max_output_tokens: 8_192,
        },
      },
    });
    if (report.status !== "analyzed") throw new Error("Expected analysis");
    expect(report.result.units).toHaveLength(2);
    expect(report.result.units[0]?.summary).toMatchObject({
      scope: "Périmètre détaillé du lot 1",
      services: ["Prestations du lot 1"],
      requirements: ["Exigences du lot 1"],
      amounts: ["Montant du lot 1"],
      watchpoints: ["Vigilance du lot 1"],
    });
    expect(sink.write).not.toHaveBeenCalled();
    expect(recordLearningUsage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_shadow_result",
      expect.objectContaining({ tender_id: "tender-1", score: 100 }),
    );
  });

  it("writes once in apply, then records the applied learning rules", async () => {
    const sink: AnalysisResultSink = { write: vi.fn().mockResolvedValue(undefined) };
    const recordLearningUsage = vi.fn().mockResolvedValue(undefined);

    const report = await runAnalyzeService({
      config: config("apply"),
      dossier,
      client: client(),
      recallLearning: vi.fn().mockResolvedValue(learning),
      sink,
      recordLearningUsage,
      now: () => new Date("2026-07-20T20:00:00.000Z"),
    });

    expect(report.status).toBe("analyzed");
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(sink.write).toHaveBeenCalledWith(expect.objectContaining({
      tenderId: "tender-1",
      tenderValues: expect.objectContaining({
        relevance_score: 100,
        dce_analyzed_at: "2026-07-20T20:00:00.000Z",
        ai_analysis_model: "openai/gpt-5.6-terra",
      }),
      lots: expect.arrayContaining([
        expect.objectContaining({ number: "1", relevanceScore: 100 }),
        expect.objectContaining({ number: "2", relevanceScore: 60 }),
      ]),
      ledger: expect.objectContaining({
        step: "dce_scoring",
        metadata: expect.objectContaining({
          lessons_count: 1,
          rules_count: 1,
          learning_applied: true,
        }),
      }),
    }));
    expect(recordLearningUsage).toHaveBeenCalledWith(["rule-1"]);
  });

  it("caps the applied analysis and records the deadline gate in the details", async () => {
    const sink: AnalysisResultSink = { write: vi.fn().mockResolvedValue(undefined) };

    const report = await runAnalyzeService({
      config: config("apply"),
      dossier,
      deadlineDate: "2026-07-25",
      client: client(),
      recallLearning: vi.fn().mockResolvedValue(learning),
      sink,
      now: () => new Date("2026-07-20T20:00:00.000Z"),
    });

    expect(report.status).toBe("analyzed");
    if (report.status !== "analyzed") throw new Error("Expected analysis");
    expect(report.result.deadlineGate).toBe("applied");
    const warning =
      "Délai de réponse trop court (DLRO le 2026-07-25, fenêtre minimale 15 j)";
    expect(sink.write).toHaveBeenCalledWith(expect.objectContaining({
      tenderValues: expect.objectContaining({
        relevance_score: 40,
        watchpoints: expect.arrayContaining([warning]),
        dce_analysis_details: expect.objectContaining({
          deadline_gate: "applied",
        }),
      }),
      lots: expect.arrayContaining([
        expect.objectContaining({ number: "1", relevanceScore: 40 }),
        expect.objectContaining({ number: "2", relevanceScore: 40 }),
      ]),
    }));
  });

  it("marks the gate unknown without touching scores when no deadline is known", async () => {
    const sink: AnalysisResultSink = { write: vi.fn().mockResolvedValue(undefined) };

    const report = await runAnalyzeService({
      config: config("apply"),
      dossier,
      deadlineDate: null,
      client: client(),
      recallLearning: vi.fn().mockResolvedValue(learning),
      sink,
      now: () => new Date("2026-07-20T20:00:00.000Z"),
    });

    expect(report.status).toBe("analyzed");
    expect(sink.write).toHaveBeenCalledWith(expect.objectContaining({
      tenderValues: expect.objectContaining({
        relevance_score: 100,
        dce_analysis_details: expect.objectContaining({
          deadline_gate: "unknown",
        }),
      }),
    }));
  });

  it("fails closed before analysis when apply has no sink", async () => {
    const generate = vi.fn();
    const promise = runAnalyzeService({
      config: config("apply"),
      dossier,
      client: { generate },
      recallLearning: vi.fn().mockResolvedValue(learning),
    });

    await expect(promise).rejects.toBeInstanceOf(AnalyzeApplySinkRequiredError);
    expect(generate).not.toHaveBeenCalled();
  });
});
