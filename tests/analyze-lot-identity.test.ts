import { describe, expect, it } from "vitest";

import {
  reconcileLotIdentities,
  type ExistingLotIdentity,
} from "../src/analyze/lot-identity.js";
import type { AnalysisLotValues } from "../src/analyze/service.js";

function lot(number: string | null, title: string): AnalysisLotValues {
  return {
    sourceLotKey: null,
    number,
    title,
    relevanceScore: 80,
    relevanceReason: "Fit",
    verdict: "relevant",
    forcedZero: false,
    summary: null,
    businessFields: null,
  };
}

function existing(
  overrides: Partial<ExistingLotIdentity> = {},
): ExistingLotIdentity {
  return {
    id: "lot-existing-1",
    sourceLotKey: "metadata:lot-1",
    number: "1",
    title: "Gros œuvre",
    order: 0,
    ...overrides,
  };
}

describe("reconcileLotIdentities", () => {
  it("normalizes a reliable positive number before building the source key", () => {
    const result = reconcileLotIdentities([lot("Lot n°01", "Gros œuvre")], []);

    expect(result.lots).toEqual([
      expect.objectContaining({ number: "1", sourceLotKey: "number:1" }),
    ]);
    expect(result.issues).toEqual([]);
  });

  it("recovers a real positive number from the title when the raw number is zero", () => {
    const result = reconcileLotIdentities(
      [lot("0", "Lot 0 - Lot 3 : Étanchéité")],
      [],
    );

    expect(result.lots).toEqual([
      expect.objectContaining({ number: "3", sourceLotKey: "number:3" }),
    ]);
    expect(result.issues).toEqual([]);
  });

  it("rejects an unresolved Lot 0 instead of materializing a canonical zero", () => {
    const result = reconcileLotIdentities([lot("Lot 0", "Terrassement")], []);

    expect(result.lots).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "lot_zero_unresolved", candidateIndex: 0 }),
    ]);
  });

  it("builds stable title-and-order identities independently of model output order", () => {
    const forward = reconcileLotIdentities([
      lot("sans numéro", "Électricité"),
      lot("sans numéro", "Gros œuvre"),
    ], []);
    const reverse = reconcileLotIdentities([
      lot("sans numéro", "Gros œuvre"),
      lot("sans numéro", "Électricité"),
    ], []);

    const byTitle = (result: typeof forward) => Object.fromEntries(
      result.lots.map((entry) => [entry.title, entry.sourceLotKey]),
    );
    expect(byTitle(reverse)).toEqual(byTitle(forward));
    expect(forward.lots.every((entry) =>
      entry.sourceLotKey?.startsWith("title:")
    )).toBe(true);
  });

  it("keeps one deterministic candidate when two raw numbers describe one identity", () => {
    const result = reconcileLotIdentities([
      lot("01", "Gros œuvre"),
      lot("Lot 1", "Gros œuvre principal"),
      lot("2", "Électricité"),
    ], []);

    expect(result.lots.map((entry) => entry.sourceLotKey)).toEqual([
      "number:1",
      "number:2",
    ]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "duplicate_candidate_identity" }),
    ]);
  });

  it("reuses the stored source key when the reliable number matches an existing child", () => {
    const result = reconcileLotIdentities(
      [lot("1", "Gros œuvre relu")],
      [existing()],
    );

    expect(result.lots).toEqual([
      expect.objectContaining({ sourceLotKey: "metadata:lot-1", number: "1" }),
    ]);
    expect(result.issues).toEqual([]);
  });

  it("fails closed when one documentary identity matches multiple DB children", () => {
    const result = reconcileLotIdentities(
      [lot("1", "Gros œuvre")],
      [
        existing(),
        existing({ id: "lot-existing-2", sourceLotKey: "metadata:lot-1-bis" }),
      ],
    );

    expect(result.lots).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "ambiguous_existing_identity" }),
    ]);
  });

  it("does not create beside a matching DB child whose source key is missing", () => {
    const result = reconcileLotIdentities(
      [lot("1", "Gros œuvre")],
      [existing({ sourceLotKey: null })],
    );

    expect(result.lots).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "existing_identity_missing_source_key" }),
    ]);
  });
});
