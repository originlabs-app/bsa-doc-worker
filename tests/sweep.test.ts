import { describe, expect, it } from "vitest";

import { classifySweepCandidate } from "../src/sweep.js";

describe("classifySweepCandidate", () => {
  it("accepts an exact AWS title for protocol A", () => {
    expect(
      classifySweepCandidate(
        {
          protocol: "A",
          title: "Construction du musée de Saint-Gilles",
          reference: "",
          buyerName: "",
        },
        {
          canonicalTitle: "Construction du musée de Saint-Gilles",
          reference: "26-041",
          buyerName: "Ville de Saint-Gilles",
        },
      ),
    ).toEqual({ accepted: true, matchedBy: "source_portal_exact_title" });
  });

  it("accepts protocol B only with an exact reference", () => {
    expect(
      classifySweepCandidate(
        {
          protocol: "B",
          title: "Texte Nukema tronqué",
          reference: "AO-2026-041",
          buyerName: "",
        },
        {
          canonicalTitle: "Un autre libellé canonique",
          reference: "ao-2026-041",
          buyerName: "Acheteur public",
        },
      ),
    ).toEqual({ accepted: true, matchedBy: "exact_reference" });
  });

  it("accepts protocol B with exact buyer and strict title prefix", () => {
    expect(
      classifySweepCandidate(
        {
          protocol: "B",
          title: "Travaux d'entretien du groupe hospitalier",
          reference: "",
          buyerName: "Assistance Publique - Hôpitaux de Paris",
        },
        {
          canonicalTitle:
            "Travaux d’entretien du groupe hospitalier — Sorbonne Université",
          reference: "2026-100",
          buyerName: "ASSISTANCE PUBLIQUE HOPITAUX DE PARIS",
        },
      ),
    ).toEqual({ accepted: true, matchedBy: "exact_buyer_and_title" });
  });

  it("rejects a title-only protocol B candidate when identity is missing", () => {
    expect(
      classifySweepCandidate(
        {
          protocol: "B",
          title: "Construction du musée de Saint-Gilles",
          reference: "",
          buyerName: "",
        },
        {
          canonicalTitle: "Construction du musée de Saint-Gilles",
          reference: "26-041",
          buyerName: "Ville de Saint-Gilles",
        },
      ),
    ).toEqual({ accepted: false, reason: "target_identity_missing" });
  });

  it("rejects an approximate buyer-title match", () => {
    expect(
      classifySweepCandidate(
        {
          protocol: "B",
          title: "Construction du musée de Saint-Gilles",
          reference: "",
          buyerName: "Ville de Saint-Gilles",
        },
        {
          canonicalTitle: "Rénovation du musée de Saint-Gilles",
          reference: "26-041",
          buyerName: "Ville de Saint-Gilles",
        },
      ),
    ).toEqual({ accepted: false, reason: "strict_identity_mismatch" });
  });
});
