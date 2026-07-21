import { describe, expect, it } from "vitest";

import {
  classifyRecoveryCandidate,
  reconcilePortalCandidates,
} from "../src/recovery/matching.js";
import type {
  PortalCandidate,
  RecoveryTarget,
} from "../src/recovery/contracts.js";

const target: RecoveryTarget = {
  tenderId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  title: "Rénovation énergétique de l'école Jean Jaurès",
  buyerName: "Ville de Lyon",
  reference: "LYON-2026-042",
  buyerProfileLink: "https://achatpublic.com/consultation/example",
  lotTitles: ["Lot 01 étanchéité", "Lot 02 isolation thermique"],
};

function candidate(
  overrides: Partial<PortalCandidate> = {},
): PortalCandidate {
  return {
    portal: "place",
    canonicalTitle: "Rénovation énergétique de l'école Jean Jaurès",
    reference: "LYON-2026-042",
    buyerName: "Ville de Lyon",
    consultationUrl:
      "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/42",
    ...overrides,
  };
}

describe("classifyRecoveryCandidate", () => {
  it("accepts an exact normalized reference", () => {
    expect(
      classifyRecoveryCandidate(target, candidate({ reference: "lyon 2026 042" })),
    ).toMatchObject({ level: "exact", referenceExact: true });
  });

  it("accepts a strong exact-buyer and title match at 0.50", () => {
    expect(
      classifyRecoveryCandidate(
        target,
        candidate({
          reference: "different",
          canonicalTitle:
            "Rénovation énergétique école Jean Jaurès - maîtrise d'œuvre",
        }),
      ),
    ).toMatchObject({ level: "strong", buyerExact: true });
  });

  it("never promotes lot tokens alone to strong", () => {
    const result = classifyRecoveryCandidate(
      target,
      candidate({
        reference: "different",
        buyerName: "Autre acheteur",
        canonicalTitle: "Travaux étanchéité isolation d'un collège",
      }),
    );

    expect(result.lotTokenHits).toBeGreaterThanOrEqual(2);
    expect(result.level).toBe("medium");
  });

  it("keeps observed low-overlap geographic noise low", () => {
    expect(
      classifyRecoveryCandidate(
        target,
        candidate({
          reference: "26TT04",
          buyerName: "Mairie d'Aussillon",
          canonicalTitle: "Plantation d'arbres à Lyon",
        }),
      ).level,
    ).toBe("low");
  });
});

describe("reconcilePortalCandidates", () => {
  it("fails closed when two incompatible top candidates tie", () => {
    const result = reconcilePortalCandidates(target, [
      candidate(),
      candidate({
        portal: "maximilien",
        reference: "LYON-2026-042",
        canonicalTitle: "Autre consultation avec la même référence",
        consultationUrl:
          "https://marches.maximilien.fr/entreprise/consultation/99",
      }),
    ]);

    expect(result.outcome).toBe("ambiguous");
  });
});
