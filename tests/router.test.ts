import { describe, expect, it } from "vitest";

import { routePortal } from "../src/router.js";

describe("routePortal", () => {
  it("routes the proven marches-publics.info host to AW Solutions", () => {
    expect(
      routePortal("https://www.marches-publics.info/consultation?IDM=1841450"),
    ).toEqual({ platform: "aw_solutions", disposition: "adapter" });
  });

  it.each([
    "https://echanges.dila.gouv.fr/avis/example",
    "https://www.boamp.fr/avis/detail/26-123",
  ])("classifies %s as publication-only", (url) => {
    expect(routePortal(url)).toEqual({
      platform: "dila",
      disposition: "publication_only",
      reasonCode: "DILA_PUBLICATION_ONLY",
    });
  });

  it("routes PLACE to its dedicated adapter", () => {
    expect(
      routePortal("https://www.marches-publics.gouv.fr/consultation/123"),
    ).toEqual({ platform: "place", disposition: "adapter" });
  });

  it("routes Maximilien to its dedicated adapter", () => {
    expect(
      routePortal("https://marches.maximilien.fr/consultation/456"),
    ).toEqual({ platform: "maximilien", disposition: "adapter" });
  });

  it("classifies TED as a publication-only source", () => {
    expect(routePortal("https://ted.europa.eu/notice/0001")).toEqual({
      platform: "ted",
      disposition: "publication_only",
      reasonCode: "TED_PUBLICATION_ONLY",
    });
  });

  it.each([
    "https://acheteur.example.test/consultation/123",
    "https://marches-publics.info.attacker.test/consultation/123",
    "https://marches.maximilien.fr.attacker.test/consultation/123",
  ])("blocks unsupported or deceptive host %s", (url) => {
    expect(routePortal(url)).toEqual({
      platform: "unsupported",
      disposition: "blocked",
      reasonCode: "UNSUPPORTED_PORTAL",
    });
  });
});
