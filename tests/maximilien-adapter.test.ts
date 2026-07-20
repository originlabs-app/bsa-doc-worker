import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  MaximilienAdapter,
  parseMaximilienListing,
  type MaximilienBrowserDiscovery,
} from "../src/adapters/maximilien.js";
import { MockMaximilienBrowserSession } from "../src/adapters/mock-maximilien-session.js";

async function fixtureDiscovery(): Promise<MaximilienBrowserDiscovery> {
  return {
    consultationUrl:
      "https://marches.maximilien.fr/entreprise/consultation/7788",
    consultationId: "7788",
    selectedLots: ["lot-1"],
    listingHtml: await readFile(
      new URL("fixtures/maximilien/manifest.html", import.meta.url),
      "utf8",
    ),
    cookieHeader: "MAXSESSION=fixture-only",
    userAgent: "bsa-maximilien-fixture",
  };
}

describe("parseMaximilienListing", () => {
  it("projects a safe manifest from the sanitized Maximilien fixture", async () => {
    const discovery = parseMaximilienListing(await fixtureDiscovery());

    expect(discovery.safeManifest).toMatchObject({
      consultationId: "7788",
      selectedLots: ["lot-1"],
      attachments: [
        {
          fileName: "Avis de marché.pdf",
          kind: "pdf",
          expectedSize: 2048,
        },
        {
          fileName: "Pièces DCE.zip",
          kind: "zip",
          expectedSize: null,
        },
      ],
    });
    expect(discovery.ephemeralAttachments).toHaveLength(2);
    expect(JSON.stringify(discovery.safeManifest)).not.toContain("signature");
    expect(JSON.stringify(discovery.safeManifest)).not.toContain("token");
  });

  it("fails closed when Maximilien exposes no allowlisted attachment", async () => {
    const fixture = await fixtureDiscovery();

    expect(() =>
      parseMaximilienListing({
        ...fixture,
        listingHtml:
          '<a href="https://attacker.invalid/document.pdf">Document</a>',
      }),
    ).toThrow(
      "Maximilien manifest did not expose an allowlisted attachment",
    );
  });
});

describe("MockMaximilienBrowserSession", () => {
  it("discovers a manifest without credentials or network", async () => {
    const adapter = new MaximilienAdapter(
      new MockMaximilienBrowserSession(),
    );
    const discovery = await adapter.discover({
      jobId: "job-max",
      tenderId: "tender-max",
      sourceField: "link_to_buyer_profile",
      providedUrl:
        "https://marches.maximilien.fr/entreprise/consultation/7788",
      requestedLots: { kind: "ids", ids: ["lot-1"] },
    });

    expect(discovery.safeManifest.attachments).toHaveLength(2);
  });
});
