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
    lotTitles: ["Lot 01 étanchéité", "Lot 02 isolation thermique"],
    deadlineAt: "2026-09-30T10:00:00.000Z",
    recoveryDisposition: "recoverable",
    ...overrides,
  };
}

const now = new Date("2026-07-21T12:00:00.000Z");

describe("classifyRecoveryCandidate", () => {
  it("accepts an exact normalized reference corroborated by title", () => {
    expect(
      classifyRecoveryCandidate(
        target,
        candidate({ reference: "lyon 2026 042" }),
        { now },
      ),
    ).toMatchObject({
      level: "exact",
      referenceExact: true,
      titleMatched: true,
    });
  });

  it("rejects an echoed exact reference without title or buyer corroboration", () => {
    const result = classifyRecoveryCandidate(
      target,
      candidate({
        canonicalTitle: "Fourniture de véhicules utilitaires",
        buyerName: "Département du Rhône",
        lotTitles: [],
      }),
      { now },
    );

    expect(result.referenceExact).toBe(true);
    expect(result.level).not.toBe("exact");
  });

  it("stems singular and plural in a quasi-exact title prefix", () => {
    const result = classifyRecoveryCandidate(
      {
        ...target,
        title: "Fourniture et installation de classes modulaires au collège",
      },
      candidate({
        reference: "different",
        canonicalTitle:
          "Fourniture et installation de classe modulaire au collège Jean Jaurès",
        lotTitles: [],
      }),
      { now },
    );

    expect(result).toMatchObject({
      level: "strong",
      titleMatched: true,
      titlePrefixMatch: true,
      buyerMatched: true,
    });
  });

  it("allows an unknown deadline only when two lots confirm the match", () => {
    const candidateWithLots = candidate({ reference: "different" });
    delete candidateWithLots.deadlineAt;
    const withLots = classifyRecoveryCandidate(
      target,
      candidateWithLots,
      { now },
    );
    expect(withLots).toMatchObject({
      level: "strong",
      deadlineStatus: "unknown",
      lotTitleMatches: 2,
    });

    const candidateWithoutLots = candidate({
      reference: "different",
      lotTitles: [],
    });
    delete candidateWithoutLots.deadlineAt;
    const withoutLots = classifyRecoveryCandidate(
      target,
      candidateWithoutLots,
      { now },
    );
    expect(withoutLots).toMatchObject({
      level: "medium",
      deadlineStatus: "unknown",
      lotTitleMatches: 0,
    });
  });

  it("keeps an expired otherwise-strong match at A_CONFIRMER", () => {
    const result = classifyRecoveryCandidate(
      target,
      candidate({
        reference: "different",
        deadlineAt: "2026-01-10T12:00:00.000Z",
      }),
      { now },
    );

    expect(result).toMatchObject({ level: "medium", deadlineStatus: "expired" });
  });

  it.each([
    ["CHU de Montpellier", "Montpellier Méditerranée Métropole"],
    ["Ardèche Habitat", "Département de l'Ardèche"],
    ["Hauts-de-Seine Habitat", "OPH Rives de Seine Habitat"],
  ])("rejects buyer homonyms: %s / %s", (targetBuyer, candidateBuyer) => {
    const result = classifyRecoveryCandidate(
      { ...target, buyerName: targetBuyer, title: "Objet cible totalement distinct" },
      candidate({
        reference: "different",
        buyerName: candidateBuyer,
        canonicalTitle: "Autre marché sans rapport",
        lotTitles: [],
      }),
      { now },
    );
    expect(result.buyerMatched).toBe(false);
    expect(result.level).not.toBe("strong");
  });

  it("keeps a PLACE ministry umbrella plus title without lots at A_CONFIRMER", () => {
    const result = classifyRecoveryCandidate(
      {
        ...target,
        buyerName: "Assistance Publique - Hôpitaux de Paris",
        title: "Réfection des réseaux de chauffage du site Cochin",
      },
      candidate({
        reference: "different",
        buyerName: "Ministère de la Santé",
        canonicalTitle: "Réfection des réseaux de chauffage du site Cochin",
        lotTitles: [],
      }),
      { now },
    );

    expect(result).toMatchObject({
      level: "medium",
      titleMatched: true,
      buyerMatched: false,
      placeUmbrellaCompatible: true,
      lotTitleMatches: 0,
    });
  });
});

describe("reconcilePortalCandidates", () => {
  it("fails closed when two incompatible top candidates tie", () => {
    const result = reconcilePortalCandidates(target, [
      candidate({ deadlineAt: "2026-09-30T10:00:00.000Z" }),
      candidate({
        portal: "maximilien",
        reference: "LYON-2026-042",
        canonicalTitle: "Autre consultation avec la même référence",
        consultationUrl:
          "https://marches.maximilien.fr/entreprise/consultation/99",
      }),
    ], { now });

    expect(result.outcome).toBe("ambiguous");
  });
});
