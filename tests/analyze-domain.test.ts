import { describe, expect, it } from "vitest";

import {
  AgentAnalysisDraftSchema,
  applyDeadlineGate,
  computeFinalScoreFromCriteria,
  finalizeAnalysisDraft,
  LotBusinessFieldsSchema,
  shouldAutoMaterializeTenderLots,
  type AgentAnalysisDraft,
  type LotMaterializationTender,
  type CompanyProfile,
  type FinalizedAnalysis,
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

describe("applyDeadlineGate", () => {
  const now = new Date("2026-07-21T00:00:00.000Z");
  const warning =
    "Délai de réponse trop court (DLRO le 2026-08-04, fenêtre minimale 15 j)";

  function analysis(): FinalizedAnalysis {
    return finalizeAnalysisDraft({
      draft: AgentAnalysisDraftSchema.parse({
        marketSummary: "Deux lots accessibles.",
        units: [
          lot({ number: "1", title: "Petit œuvre", metier: 15 }),
          lot({ number: "2", title: "Gros œuvre", metier: 30 }),
        ],
      }),
      company,
      mandatoryQualifications,
    });
  }

  it("caps the global score and every unit at 40 when the DLRO is too close", () => {
    const gated = applyDeadlineGate({
      analysis: analysis(),
      deadlineDate: "2026-08-04",
      minimumDays: 15,
      now,
    });

    expect(gated.deadlineGate).toBe("applied");
    expect(gated.score).toBe(40);
    expect(gated.units.map((unit) => unit.score)).toEqual([40, 40]);
    expect(gated.watchpoints).toContain(warning);
    for (const unit of gated.units) {
      expect(unit.summary.watchpoints).toContain(warning);
    }
  });

  it("passes a deadline sitting exactly on the minimum window", () => {
    const source = analysis();
    const gated = applyDeadlineGate({
      analysis: source,
      deadlineDate: "2026-08-05",
      minimumDays: 15,
      now,
    });

    expect(gated.deadlineGate).toBe("passed");
    expect(gated.score).toBe(source.score);
    expect(gated.units.map((unit) => unit.score))
      .toEqual(source.units.map((unit) => unit.score));
    expect(gated.watchpoints).not.toContain(warning);
  });

  it("keeps the analysis untouched when the deadline is absent or unreadable", () => {
    const source = analysis();
    for (const deadlineDate of [null, "  ", "pas-une-date"]) {
      const gated = applyDeadlineGate({
        analysis: source,
        deadlineDate,
        minimumDays: 15,
        now,
      });
      expect(gated.deadlineGate).toBe("unknown");
      expect(gated.score).toBe(source.score);
      expect(gated.units.map((unit) => unit.score))
        .toEqual(source.units.map((unit) => unit.score));
      expect(gated.watchpoints).not.toContain(warning);
    }
  });

  it("does not duplicate the watchpoint nor lift a score already under 40", () => {
    const source = analysis();
    const belowCap: FinalizedAnalysis = {
      ...source,
      score: 25,
      watchpoints: [...source.watchpoints, warning],
      units: source.units.map((unit) => ({
        ...unit,
        score: 25,
        summary: {
          ...unit.summary,
          watchpoints: [...unit.summary.watchpoints, warning],
        },
      })),
    };

    const gated = applyDeadlineGate({
      analysis: belowCap,
      deadlineDate: "2026-08-04",
      minimumDays: 15,
      now,
    });

    expect(gated.deadlineGate).toBe("applied");
    expect(gated.score).toBe(25);
    expect(gated.units.map((unit) => unit.score)).toEqual([25, 25]);
    expect(gated.watchpoints.filter((entry) => entry === warning)).toHaveLength(1);
    for (const unit of gated.units) {
      expect(unit.summary.watchpoints.filter((entry) => entry === warning))
        .toHaveLength(1);
    }
  });
});

describe("shouldAutoMaterializeTenderLots", () => {
  const eligible: LotMaterializationTender = {
    source: "Nukema API",
    status: "opportunity",
    record_type: "market",
    lot_structure_mode: "multi",
    lot_structure_origin: "nukema_bot",
    lot_structure_locked_at: null,
  };

  // Exact truth table of the edge guard, market branch.
  const cases: Array<{
    label: string;
    tender: LotMaterializationTender;
    expected: boolean;
  }> = [
    { label: "eligible nukema multi market", tender: eligible, expected: true },
    {
      label: "non-nukema source",
      tender: { ...eligible, source: "manual" },
      expected: false,
    },
    {
      label: "null source",
      tender: { ...eligible, source: null },
      expected: false,
    },
    {
      label: "qualified status",
      tender: { ...eligible, status: "qualified" },
      expected: false,
    },
    {
      label: "locked structure",
      tender: { ...eligible, lot_structure_locked_at: "2026-07-20T10:00:00Z" },
      expected: false,
    },
    {
      label: "standalone record (worker scope excludes the edge standalone branch)",
      tender: { ...eligible, record_type: "standalone" },
      expected: false,
    },
    {
      label: "direct lot record",
      tender: { ...eligible, record_type: "lot" },
      expected: false,
    },
    {
      label: "single-lot structure",
      tender: { ...eligible, lot_structure_mode: "single" },
      expected: false,
    },
    {
      label: "null structure mode",
      tender: { ...eligible, lot_structure_mode: null },
      expected: false,
    },
    {
      label: "human-owned structure",
      tender: { ...eligible, lot_structure_origin: "human" },
      expected: false,
    },
    {
      label: "null structure origin",
      tender: { ...eligible, lot_structure_origin: null },
      expected: false,
    },
  ];

  for (const entry of cases) {
    it(entry.label, () => {
      expect(shouldAutoMaterializeTenderLots(entry.tender)).toBe(entry.expected);
    });
  }
});

describe("LotBusinessFieldsSchema", () => {
  const valid = {
    summaryDescription: { value: "Gros œuvre", citation: "Le lot comprend le gros œuvre" },
    contractDuration: { value: "12 mois", citation: "Durée du marché : 12 mois" },
    workStartDate: { value: "2026-09-01", citation: "Démarrage le 1er septembre 2026" },
    estimatedValue: { value: 250_000, citation: "Montant estimé : 250 000 € HT" },
  };

  it("accepts a fully cited set of business fields", () => {
    expect(LotBusinessFieldsSchema.parse(valid)).toEqual(valid);
  });

  it("accepts null fields for values absent from the documents", () => {
    const empty = {
      summaryDescription: null,
      contractDuration: null,
      workStartDate: null,
      estimatedValue: null,
    };
    expect(LotBusinessFieldsSchema.parse(empty)).toEqual(empty);
  });

  it("rejects a blank citation, a malformed date and a non-positive amount", () => {
    expect(LotBusinessFieldsSchema.safeParse({
      ...valid,
      summaryDescription: { value: "Gros œuvre", citation: "   " },
    }).success).toBe(false);
    expect(LotBusinessFieldsSchema.safeParse({
      ...valid,
      workStartDate: { value: "01/09/2026", citation: "Démarrage" },
    }).success).toBe(false);
    expect(LotBusinessFieldsSchema.safeParse({
      ...valid,
      estimatedValue: { value: 0, citation: "Montant" },
    }).success).toBe(false);
  });
});
