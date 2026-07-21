import { describe, expect, it, vi } from "vitest";

import {
  AnalyzeStepBudgetError,
  AnalyzeToolBudgetError,
  createAnalysisToolbox,
  createOpenRouterDceAnalystClient,
  runDceAnalyst,
  type AgentGenerationClient,
  type AgentGenerationResult,
  type AnalyzeDossierInput,
  type AnalyzeLearningSnapshot,
  type AnalyzeLlmInvalidOutputError,
} from "../src/analyze/index.js";

const learning: AnalyzeLearningSnapshot = {
  lessons: [{
    id: "lesson-1",
    kind: "go",
    tenderRef: "AO-OLD",
    title: "Ancien marché proche",
    lessonText: "Raison: très bon alignement métier",
    decidedAt: "2026-07-01T00:00:00.000Z",
    similarity: 0.91,
  }],
  rules: [{
    id: "rule-1",
    title: "Éviter la haute tension",
    description: "Le client ne traite pas la haute tension.",
    recommendedAction: "Pénaliser les lots HTA",
    patternType: "business_exclusion",
    confidence: "high",
  }],
  context: "DOSSIER SIMILAIRE: Ancien marché proche → GO",
};

const dossier: AnalyzeDossierInput = {
  tender: {
    id: "tender-1",
    title: "Travaux de rénovation",
    buyerName: "Ville test",
    description: "Rénovation de deux bâtiments",
    location: "Paris",
    estimatedAmount: 500_000,
    procedureType: "Procédure adaptée",
  },
  company: {
    name: "BSA Test",
    core_business: "Rénovation générale",
    certifications_held: [],
  },
  mandatoryQualifications: [],
  documents: [{
    id: "rc-1",
    fileName: "RC.pdf",
    role: "rc",
    lotNumber: null,
    text: "A".repeat(45_000),
  }],
};

const validOutput = {
  marketSummary: "Marché de rénovation de deux bâtiments.",
  units: [{
    unit: { kind: "market" as const },
    proposedVerdict: "favorable" as const,
    businessFields: null,
    rationale: "Le besoin correspond au métier de l'entreprise.",
    criteria: {
      metier: 30,
      geo: 20,
      montant: 0,
      procedure: 15,
      certifications: 0,
    },
    unknownCriteria: ["montant" as const, "certifications" as const],
    summary: {
      scope: "Rénovation complète.",
      services: ["Second œuvre"],
      requirements: ["Maintien du site en activité"],
      qualifications: [],
      amounts: ["Montant non ventilé"],
      watchpoints: [],
    },
    requiredQualifications: [],
    socialInsertion: null,
    citations: [{ documentId: "rc-1", excerpt: "Rénovation complète" }],
  }],
};

function result(output: unknown, stepsUsed = 3): AgentGenerationResult {
  return {
    output,
    stepsUsed,
    costUsd: 0.02,
    usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
  };
}

describe("runDceAnalyst", () => {
  it("passes the bounded budget and learning context to the generation client", async () => {
    const generate = vi.fn().mockResolvedValue(result(validOutput));
    const client: AgentGenerationClient = { generate };

    const analyzed = await runDceAnalyst({
      dossier,
      learning,
      client,
      config: { maxSteps: 8, maxOutputTokens: 8_192 },
    });

    expect(analyzed.attempts).toBe(1);
    expect(analyzed.draft.marketSummary).toContain("rénovation");
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      dossier,
      learning,
      repair: false,
      maxSteps: 8,
      maxOutputTokens: 8_192,
    }));
  });

  it("retries one invalid Zod output and then succeeds", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(result({ marketSummary: "incomplet" }))
      .mockResolvedValueOnce(result(validOutput));

    const analyzed = await runDceAnalyst({
      dossier,
      learning,
      client: { generate },
      config: { maxSteps: 8, maxOutputTokens: 8_192 },
    });

    expect(analyzed.attempts).toBe(2);
    expect(analyzed.costUsd).toBe(0.04);
    expect(generate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        repair: true,
        maxSteps: 5,
        maxOutputTokens: 7_692,
      }),
    );
  });

  it("fails cleanly after two invalid outputs", async () => {
    const generate = vi.fn().mockResolvedValue(result({ invalid: true }));

    const promise = runDceAnalyst({
      dossier,
      learning,
      client: { generate },
      config: { maxSteps: 8, maxOutputTokens: 8_192 },
    });

    await expect(promise).rejects.toMatchObject({
      name: "AnalyzeLlmInvalidOutputError",
      code: "ANALYZE_LLM_INVALID_OUTPUT",
      attempts: 2,
      costUsd: 0.04,
    } satisfies Partial<AnalyzeLlmInvalidOutputError>);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("retries an analysis that omits an explicitly identified lot", async () => {
    const allottedDossier: AnalyzeDossierInput = {
      ...dossier,
      documents: [
        { ...dossier.documents[0]!, id: "lot-1", lotNumber: "1" },
        { ...dossier.documents[0]!, id: "lot-2", lotNumber: "2" },
      ],
    };
    const lotOutput = {
      marketSummary: "Marché en deux lots.",
      units: ["1", "2"].map((number) => ({
        ...validOutput.units[0],
        unit: { kind: "lot" as const, number, title: `Lot ${number}` },
        citations: [{ documentId: `lot-${number}`, excerpt: `Lot ${number}` }],
      })),
    };
    const generate = vi.fn()
      .mockResolvedValueOnce(result(validOutput))
      .mockResolvedValueOnce(result(lotOutput));

    const analyzed = await runDceAnalyst({
      dossier: allottedDossier,
      learning,
      client: { generate },
      config: { maxSteps: 8, maxOutputTokens: 8_192 },
    });

    expect(analyzed.attempts).toBe(2);
    expect(analyzed.draft.units).toHaveLength(2);
  });

  it("rejects a client result beyond the configured step ceiling", async () => {
    const promise = runDceAnalyst({
      dossier,
      learning,
      client: { generate: vi.fn().mockResolvedValue(result(validOutput, 9)) },
      config: { maxSteps: 8, maxOutputTokens: 8_192 },
    });

    await expect(promise).rejects.toBeInstanceOf(AnalyzeStepBudgetError);
  });
});

describe("createAnalysisToolbox", () => {
  it("reads extracted documents through bounded cursor windows", () => {
    const toolbox = createAnalysisToolbox({ dossier, learning });

    const first = toolbox.readDocument({ documentId: "rc-1", cursor: 0 });
    const second = toolbox.readDocument({
      documentId: "rc-1",
      cursor: first.nextCursor ?? 0,
    });

    expect(first.text).toHaveLength(20_000);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(20_000);
    expect(second.start).toBe(20_000);
  });

  it("fails closed when the document-read call budget is exhausted", () => {
    const toolbox = createAnalysisToolbox({
      dossier,
      learning,
      limits: { documentReadCalls: 1, documentReadCharacters: 20_000 },
    });

    toolbox.readDocument({ documentId: "rc-1", cursor: 0 });
    expect(() => toolbox.readDocument({ documentId: "rc-1", cursor: 20_000 }))
      .toThrow(AnalyzeToolBudgetError);
  });

  it("checks redhibitory rules with the deterministic evaluator", () => {
    const toolbox = createAnalysisToolbox({
      dossier: {
        ...dossier,
        company: { ...dossier.company, accepts_social_insertion: false },
      },
      learning,
    });

    expect(
      toolbox.checkRedhibitoryRules({
        requiredQualifications: [],
        socialInsertion: { present: true, detail: "500 heures" },
      }),
    ).toMatchObject({ redhibitory: true });
  });
});

describe("createOpenRouterDceAnalystClient", () => {
  it("uses AI SDK structured output, four tools and the bounded stop condition", async () => {
    const generateText = vi.fn().mockResolvedValue({
      output: validOutput,
      steps: [{}, {}, {}],
      usage: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
      providerMetadata: { openrouter: { usage: { cost: 0.013 } } },
    });
    const client = createOpenRouterDceAnalystClient({
      apiKey: "test-key",
      model: "openai/gpt-5.6-terra",
      languageModel: "mock-model",
      generateText,
    });

    const generated = await client.generate({
      dossier,
      learning,
      repair: false,
      maxSteps: 8,
      maxOutputTokens: 8_192,
    });

    expect(generated).toMatchObject({
      output: validOutput,
      stepsUsed: 3,
      costUsd: 0.013,
    });
    const options = generateText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({
      model: "mock-model",
      maxRetries: 2,
      maxOutputTokens: 8_192,
    });
    expect(Object.keys(options.tools as object)).toEqual([
      "read_document",
      "consult_company_profile",
      "recall_learning",
      "check_redhibitory_rules",
    ]);
    expect(String(options.prompt)).toContain(learning.context);
    expect(String(options.prompt)).toContain("RC.pdf");
    const stopWhen = options.stopWhen as (input: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: Array.from({ length: 8 }) })).toBe(true);
  });
});
