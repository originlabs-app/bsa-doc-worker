import { describe, expect, it, vi } from "vitest";

import {
  buildAnalyzeLearningSnapshot,
  formatVector,
  selectLessonsForPrompt,
  type ApprovedLearningRuleRecord,
  type LearningMemoryStore,
  type SimilarLesson,
} from "../src/analyze/index.js";

const lessons: SimilarLesson[] = [
  {
    id: "reject-1",
    kind: "rejected",
    tenderRef: "A",
    title: "Très proche mais rejeté",
    lessonText: "Raison: hors métier",
    decidedAt: "2026-07-10T00:00:00.000Z",
    similarity: 0.95,
  },
  {
    id: "no-go-1",
    kind: "no_go",
    tenderRef: "B",
    title: "Deuxième dossier",
    lessonText: "Raison: charge insuffisante",
    decidedAt: "2026-07-09T00:00:00.000Z",
    similarity: 0.9,
  },
  {
    id: "go-1",
    kind: "go",
    tenderRef: "C",
    title: "GO de référence",
    lessonText: "Raison: cœur de métier exact",
    decidedAt: "2026-07-08T00:00:00.000Z",
    similarity: 0.7,
  },
];

const rules: ApprovedLearningRuleRecord[] = [
  {
    id: "rule-match",
    title: "Haute tension exclue",
    description: "Pénaliser les marchés HTA.",
    recommendedAction: "Classer hors cible",
    matchTerms: ["haute tension"],
    negativeTerms: [],
    patternType: "business_exclusion",
    confidence: "high",
  },
  {
    id: "rule-negative",
    title: "Rénovation hors Île-de-France",
    description: "Ne s'applique pas en Île-de-France.",
    recommendedAction: null,
    matchTerms: ["rénovation"],
    negativeTerms: ["paris"],
    patternType: "geo",
    confidence: "medium",
  },
];

describe("selectLessonsForPrompt", () => {
  it("keeps a sufficiently similar GO even when it falls outside top K", () => {
    expect(selectLessonsForPrompt(lessons, { topK: 2 })).toEqual([
      lessons[0],
      lessons[2],
    ]);
  });
});

describe("buildAnalyzeLearningSnapshot", () => {
  it("recalls lessons, filters approved rules and builds a measurable context", async () => {
    const store: LearningMemoryStore = {
      matchLessons: vi.fn().mockResolvedValue(lessons),
      listApprovedRules: vi.fn().mockResolvedValue(rules),
      recordRuleUsage: vi.fn(),
    };

    const snapshot = await buildAnalyzeLearningSnapshot({
      enabled: true,
      companyId: "company-1",
      tender: {
        id: "tender-1",
        title: "Rénovation haute tension à Paris",
        buyerName: "Ville",
        description: "Travaux HTA",
        location: "Paris",
        estimatedAmount: null,
        procedureType: null,
      },
      store,
      embed: vi.fn().mockResolvedValue(Array.from({ length: 768 }, () => 0.1)),
    });

    expect(snapshot.lessons).toHaveLength(3);
    expect(snapshot.rules.map((rule) => rule.id)).toEqual(["rule-match"]);
    expect(snapshot.context).toContain("GO de référence");
    expect(snapshot.context).toContain("Haute tension exclue");
    expect(snapshot.context).not.toContain("Rénovation hors Île-de-France");
  });

  it("fails open with an empty snapshot when memory dependencies are unavailable", async () => {
    const snapshot = await buildAnalyzeLearningSnapshot({
      enabled: true,
      companyId: "company-1",
      tender: {
        id: "tender-1",
        title: "Marché",
        buyerName: null,
        description: null,
        location: null,
        estimatedAmount: null,
        procedureType: null,
      },
      store: {
        matchLessons: vi.fn().mockRejectedValue(new Error("offline")),
        listApprovedRules: vi.fn().mockRejectedValue(new Error("offline")),
        recordRuleUsage: vi.fn(),
      },
      embed: vi.fn().mockRejectedValue(new Error("offline")),
    });

    expect(snapshot).toEqual({ lessons: [], rules: [], context: "" });
  });
});

describe("formatVector", () => {
  it("rejects non-finite embedding values", () => {
    expect(() => formatVector([0.1, Number.NaN])).toThrow(
      "Embedding contains a non-finite value",
    );
  });
});
