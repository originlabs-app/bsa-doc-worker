import { describe, expect, it, vi } from "vitest";

import {
  citationSupportsLotAmount,
  degradeUngroundedBusinessFields,
  parseDocumentaryNumberToken,
} from "../src/analyze/grounding.js";
import {
  runAnalyzeService,
  type AnalyzeConfig,
  type AnalyzeDossierInput,
  type AnalysisResultSink,
} from "../src/analyze/index.js";
import { AgentAnalysisDraftSchema } from "../src/analyze/types.js";

// ─── Edge ports (analyze-dce/handler.ts) ────────────────────────────────────

describe("parseDocumentaryNumberToken (edge port)", () => {
  const cases: Array<[string, number | null]> = [
    ["250 000", 250_000],
    ["250 000", 250_000],
    ["250 000", 250_000],
    ["250.000", 250_000],
    ["1.234.567,89", 1_234_567.89],
    ["1,234", 1_234],
    ["1,23", 1.23],
    ["3.25", 3.25],
    ["1'500'000", 1_500_000],
    ["abc", null],
    ["12.34.56", 123_456],
  ];
  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} as ${expected}`, () => {
      expect(parseDocumentaryNumberToken(input)).toBe(expected);
    });
  }
});

describe("citationSupportsLotAmount (edge port)", () => {
  const supported: Array<[string, number]> = [
    ["Montant estimé : 250 000 € HT", 250_000],
    ["225 k€ par an", 225_000],
    ["1,5 M€", 1_500_000],
    ["2 M€ maximum", 2_000_000],
    ["1.234.567,89 €", 1_234_567.89],
    ["250.000 €", 250_000],
    ["environ 250000€", 250_000],
    ["250 000 €", 250_000],
    ["montant : 3,25 €", 3.25],
    ["forfait 225 keur annuel", 225_000],
  ];
  for (const [citation, amount] of supported) {
    it(`accepts ${JSON.stringify(citation)} for ${amount}`, () => {
      expect(citationSupportsLotAmount(citation, amount)).toBe(true);
    });
  }

  const unsupported: Array<[string, number]> = [
    ["Montant global du marché", 250_000],
    ["12 mois", 250_000],
    ["225 k", 225_000],
    ["250 001 €", 250_000],
  ];
  for (const [citation, amount] of unsupported) {
    it(`refuses ${JSON.stringify(citation)} for ${amount}`, () => {
      expect(citationSupportsLotAmount(citation, amount)).toBe(false);
    });
  }
});

// ─── Business-field grounding (LOT D) ───────────────────────────────────────

const documents: AnalyzeDossierInput["documents"] = [
  {
    id: "ccap-1",
    fileName: "CCAP.pdf",
    role: "ccap",
    lotNumber: null,
    text: "Durée du marché : 12   mois. Démarrage prévu le 2026-09-01.",
  },
  {
    id: "dpgf-1",
    fileName: "DPGF lot 1.xlsx",
    role: "dpgf",
    lotNumber: "1",
    text: "Lot 1 gros œuvre.\nMontant estimé : 250 000 € HT pour le lot.",
  },
];

function draftWith(
  businessFields: Record<string, unknown> | null,
): ReturnType<typeof AgentAnalysisDraftSchema.parse> {
  return AgentAnalysisDraftSchema.parse({
    rosterComplete: true,
    marketSummary: "Marché à lot unique identifié.",
    units: [{
      unit: { kind: "lot", number: "1", title: "Gros œuvre" },
      proposedVerdict: "favorable",
      businessFields,
      rationale: "Le lot correspond au métier.",
      criteria: { metier: 30, geo: 20, montant: 20, procedure: 15, certifications: 0 },
      unknownCriteria: ["certifications"],
      summary: {
        scope: "Gros œuvre.",
        services: ["Maçonnerie"],
        requirements: [],
        qualifications: [],
        amounts: [],
        watchpoints: [],
      },
      requiredQualifications: [],
      socialInsertion: null,
      citations: [{ documentId: "dpgf-1", excerpt: "Lot 1 gros œuvre" }],
    }],
  });
}

const groundedFields = {
  summaryDescription: {
    value: "Gros œuvre du bâtiment",
    citation: "Lot 1 gros œuvre.",
    documentId: "dpgf-1",
  },
  contractDuration: {
    value: "12 mois",
    citation: "durée du marché : 12 MOIS.",
    documentId: "ccap-1",
  },
  workStartDate: {
    value: "2026-09-01",
    citation: "Démarrage prévu le 2026-09-01",
    documentId: "ccap-1",
  },
  estimatedValue: {
    value: 250_000,
    citation: "Montant estimé : 250 000 € HT",
    documentId: "dpgf-1",
  },
};

describe("degradeUngroundedBusinessFields", () => {
  it("keeps fields whose citation matches the designated document (case/space-insensitive)", () => {
    const log = vi.fn();
    const degraded = degradeUngroundedBusinessFields({
      draft: draftWith(groundedFields),
      documents,
      log,
    });

    expect(degraded.units[0]?.businessFields).toEqual(groundedFields);
    expect(log).not.toHaveBeenCalled();
  });

  it("degrades an invented citation to an absent field with a dedicated log, never a throw", () => {
    const log = vi.fn();
    const degraded = degradeUngroundedBusinessFields({
      draft: draftWith({
        ...groundedFields,
        summaryDescription: {
          value: "Maçonnerie",
          citation: "Le lot comprend la maçonnerie complète",
          documentId: "dpgf-1",
        },
      }),
      documents,
      log,
    });

    expect(degraded.units[0]?.businessFields?.summaryDescription).toBeNull();
    expect(degraded.units[0]?.businessFields?.estimatedValue).toEqual(
      groundedFields.estimatedValue,
    );
    expect(log).toHaveBeenCalledWith(
      "analyze_business_field_degraded",
      expect.objectContaining({
        field: "summaryDescription",
        reason: "citation_not_found",
        document_id: "dpgf-1",
      }),
    );
  });

  it("degrades a field whose documentId is not part of the assembled dossier", () => {
    const log = vi.fn();
    const degraded = degradeUngroundedBusinessFields({
      draft: draftWith({
        ...groundedFields,
        contractDuration: {
          value: "12 mois",
          citation: "Durée du marché : 12 mois",
          documentId: "doc-inconnu",
        },
      }),
      documents,
      log,
    });

    expect(degraded.units[0]?.businessFields?.contractDuration).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "analyze_business_field_degraded",
      expect.objectContaining({
        field: "contractDuration",
        reason: "unknown_document",
        document_id: "doc-inconnu",
      }),
    );
  });

  it("degrades a citation that lives in another document than the designated one", () => {
    const degraded = degradeUngroundedBusinessFields({
      draft: draftWith({
        ...groundedFields,
        estimatedValue: {
          value: 250_000,
          citation: "Montant estimé : 250 000 € HT",
          documentId: "ccap-1",
        },
      }),
      documents,
    });

    expect(degraded.units[0]?.businessFields?.estimatedValue).toBeNull();
  });

  it("degrades an amount that the citation does not carry (edge citationSupportsLotAmount)", () => {
    const log = vi.fn();
    const degraded = degradeUngroundedBusinessFields({
      draft: draftWith({
        ...groundedFields,
        estimatedValue: {
          value: 300_000,
          citation: "Montant estimé : 250 000 € HT",
          documentId: "dpgf-1",
        },
      }),
      documents,
      log,
    });

    expect(degraded.units[0]?.businessFields?.estimatedValue).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "analyze_business_field_degraded",
      expect.objectContaining({
        field: "estimatedValue",
        reason: "amount_not_in_citation",
      }),
    );
  });

  it("leaves null business fields untouched", () => {
    const degraded = degradeUngroundedBusinessFields({
      draft: draftWith(null),
      documents,
    });
    expect(degraded.units[0]?.businessFields).toBeNull();
  });
});

// ─── Service integration: the write payload only carries grounded fields ────

describe("runAnalyzeService business-field grounding", () => {
  const dossier: AnalyzeDossierInput = {
    tender: {
      id: "tender-1",
      title: "Marché de gros œuvre",
      buyerName: null,
      description: null,
      location: null,
      estimatedAmount: null,
      procedureType: null,
    },
    company: { name: "Entreprise test" },
    mandatoryQualifications: [],
    documents,
  };

  const config: AnalyzeConfig = {
    mode: "apply",
    model: "openai/gpt-5.6-terra",
    maxSteps: 8,
    maxOutputTokens: 8_192,
    unitsPerCall: 8,
    deadlineMinDays: 15,
    recordTypes: ["market"],
    openRouterApiKey: "test",
  };

  it("nulls invented business fields in the payload and details, with a dedicated log", async () => {
    const sink: AnalysisResultSink = { write: vi.fn().mockResolvedValue(undefined) };
    const logger = { info: vi.fn() };

    const report = await runAnalyzeService({
      config,
      dossier,
      client: {
        generate: vi.fn().mockResolvedValue({
          output: {
            rosterComplete: true,
            marketSummary: "Marché à lot unique identifié.",
            units: [{
              unit: { kind: "lot", number: "1", title: "Gros œuvre" },
              proposedVerdict: "favorable",
              businessFields: {
                ...groundedFields,
                summaryDescription: {
                  value: "Maçonnerie",
                  citation: "Citation inventée absente des documents",
                  documentId: "dpgf-1",
                },
              },
              rationale: "Le lot correspond au métier.",
              criteria: {
                metier: 30,
                geo: 20,
                montant: 20,
                procedure: 15,
                certifications: 0,
              },
              unknownCriteria: ["certifications"],
              summary: {
                scope: "Gros œuvre.",
                services: ["Maçonnerie"],
                requirements: [],
                qualifications: [],
                amounts: [],
                watchpoints: [],
              },
              requiredQualifications: [],
              socialInsertion: null,
              citations: [{ documentId: "dpgf-1", excerpt: "Lot 1 gros œuvre" }],
            }],
          },
          stepsUsed: 2,
          costUsd: 0.02,
          usage: { inputTokens: 800, outputTokens: 300, totalTokens: 1_100 },
        }),
      },
      recallLearning: vi.fn().mockResolvedValue({
        lessons: [],
        rules: [],
        context: "",
      }),
      sink,
      logger,
      now: () => new Date("2026-07-21T08:00:00.000Z"),
    });

    expect(report.status).toBe("analyzed");
    const payload = vi.mocked(sink.write).mock.calls[0]?.[0];
    expect(payload?.lots[0]?.businessFields).toEqual({
      ...groundedFields,
      summaryDescription: null,
    });
    const details = payload?.tenderValues.dce_analysis_details as {
      units: Array<{ businessFields: Record<string, unknown> | null }>;
    };
    expect(details.units[0]?.businessFields?.summaryDescription).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_business_field_degraded",
      expect.objectContaining({
        tender_id: "tender-1",
        field: "summaryDescription",
        reason: "citation_not_found",
      }),
    );
  });
});
