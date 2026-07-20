import { describe, expect, it } from "vitest";

import {
  AgentAnalysisDraftSchema,
  computeFinalScoreFromCriteria,
  finalizeAnalysisDraft,
  type AgentAnalysisDraft,
  type CompanyProfile,
  type MandatoryQualification,
} from "../src/analyze/index.js";

const company: CompanyProfile = {
  name: "BSA Test",
  certifications_held: ["QUALIBAT 1552"],
  certifications_excluded: [],
  accepts_social_insertion: true,
};

const mandatoryQualifications: MandatoryQualification[] = [
  {
    code: "QUALIBAT-1552",
    label: "Qualibat 1552",
    derogeable: false,
    aliases: ["1552"],
  },
  {
    code: "RGE-ELEC",
    label: "RGE électricité",
    derogeable: false,
    aliases: ["RGE Elec"],
  },
];

function lot(input: {
  number: string;
  title: string;
  metier: number;
  requiredQualification?: string;
}): AgentAnalysisDraft["units"][number] {
  return {
    unit: { kind: "lot", number: input.number, title: input.title },
    proposedVerdict: "favorable",
    rationale: `Le lot ${input.number} correspond au métier.`,
    criteria: {
      metier: input.metier,
      geo: 20,
      montant: 20,
      procedure: 15,
      certifications: 15,
    },
    unknownCriteria: [],
    summary: {
      scope: `Périmètre du lot ${input.number}`,
      services: ["Prestations détaillées"],
      requirements: ["Exigence technique"],
      qualifications: input.requiredQualification
        ? [input.requiredQualification]
        : [],
      amounts: ["100 000 EUR"],
      watchpoints: [],
    },
    requiredQualifications: input.requiredQualification
      ? [{
          label: input.requiredQualification,
          sourceDocumentId: "rc-1",
          evidence: `Qualification ${input.requiredQualification} exigée`,
        }]
      : [],
    socialInsertion: null,
    citations: [{ documentId: "rc-1", excerpt: "Lot analysé" }],
  };
}

describe("computeFinalScoreFromCriteria", () => {
  it("matches Paul's multiplicative business gate and unknown renormalization", () => {
    expect(
      computeFinalScoreFromCriteria(
        {
          metier: 24,
          geo: 16,
          montant: 0,
          procedure: 12,
          certifications: 15,
        },
        new Set(["montant"]),
      ),
    ).toBe(69);
  });
});

describe("AgentAnalysisDraftSchema", () => {
  it("rejects an unknown criterion that the agent credited", () => {
    const invalid = {
      marketSummary: "Marché test",
      units: [{
        ...lot({ number: "1", title: "Lot unique", metier: 30 }),
        unknownCriteria: ["montant"],
      }],
    };

    expect(AgentAnalysisDraftSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("finalizeAnalysisDraft", () => {
  it("uses the best accessible lot instead of averaging lots", () => {
    const draft = AgentAnalysisDraftSchema.parse({
      marketSummary: "Deux lots accessibles.",
      units: [
        lot({ number: "1", title: "Petit œuvre", metier: 15 }),
        lot({ number: "2", title: "Gros œuvre", metier: 30 }),
      ],
    });

    const result = finalizeAnalysisDraft({
      draft,
      company,
      mandatoryQualifications,
    });

    expect(result.score).toBe(100);
    expect(result.recommendedLot).toEqual({ number: "2", title: "Gros œuvre" });
    expect(result.units.map((unit) => unit.score)).toEqual([50, 100]);
    expect(result.forcedZero).toBe(false);
  });

  it("blocks a lot in code even when the agent proposed a favorable verdict", () => {
    const draft = AgentAnalysisDraftSchema.parse({
      marketSummary: "Un lot techniquement séduisant mais bloqué.",
      units: [
        lot({
          number: "1",
          title: "Électricité",
          metier: 30,
          requiredQualification: "RGE électricité",
        }),
        lot({
          number: "2",
          title: "Désamiantage",
          metier: 24,
          requiredQualification: "Qualibat 1552",
        }),
      ],
    });

    const result = finalizeAnalysisDraft({
      draft,
      company,
      mandatoryQualifications,
    });

    expect(result.units[0]).toMatchObject({
      score: 0,
      forcedZero: true,
      verdict: "blocked",
    });
    expect(result.units[1]).toMatchObject({
      score: 80,
      forcedZero: false,
      verdict: "recommended",
    });
    expect(result.score).toBe(80);
    expect(result.forcedZero).toBe(false);
  });

  it("forces the whole tender to zero only when every lot is blocked", () => {
    const draft = AgentAnalysisDraftSchema.parse({
      marketSummary: "Tous les lots exigent une qualification absente.",
      units: [
        lot({
          number: "1",
          title: "Électricité A",
          metier: 30,
          requiredQualification: "RGE Elec",
        }),
        lot({
          number: "2",
          title: "Électricité B",
          metier: 30,
          requiredQualification: "RGE électricité",
        }),
      ],
    });

    const result = finalizeAnalysisDraft({
      draft,
      company,
      mandatoryQualifications,
    });

    expect(result.score).toBe(0);
    expect(result.forcedZero).toBe(true);
    expect(result.units.every((unit) => unit.verdict === "blocked")).toBe(true);
  });
});
