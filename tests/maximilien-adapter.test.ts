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

async function atexoQueryDiscovery(): Promise<MaximilienBrowserDiscovery> {
  return {
    consultationUrl:
      "https://marches.maximilien.fr/index.php?page=Entreprise.EntrepriseDetailsConsultation&id=942952&orgAcronyme=fixture",
    consultationId: "942952",
    selectedLots: ["all"],
    listingHtml: await readFile(
      new URL(
        "fixtures/maximilien/manifest-atexo-query.html",
        import.meta.url,
      ),
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

  it("recognises Atexo query-string download actions as pieces", async () => {
    const discovery = parseMaximilienListing(await atexoQueryDiscovery());

    expect(discovery.safeManifest.attachments).toEqual([
      expect.objectContaining({
        fileName: "Règlement de consultation - 550,89 Ko",
        kind: "unknown",
        expectedSize: null,
      }),
      expect.objectContaining({
        fileName: "Dossier de consultation - 9,38 Mo",
        kind: "unknown",
        expectedSize: null,
      }),
    ]);
    const [reglement, dossier] = discovery.ephemeralAttachments;
    expect(reglement?.downloadUrl).toContain(
      "page=Entreprise.EntrepriseDownloadReglement",
    );
    expect(dossier?.downloadUrl).toContain(
      "page=Entreprise.EntrepriseDemandeTelechargementDce",
    );
    expect(reglement?.stableId).not.toBe(dossier?.stableId);
    expect(reglement?.requestHeaders.Cookie).toBe("MAXSESSION=fixture-only");
  });

  it("excludes 'Signer un document' action links from the manifest", async () => {
    const discovery = parseMaximilienListing(await atexoQueryDiscovery());

    expect(discovery.safeManifest.attachments).toHaveLength(2);
    expect(JSON.stringify(discovery.safeManifest)).not.toContain(
      "Signer un document",
    );
    expect(
      discovery.ephemeralAttachments.some((attachment) =>
        attachment.downloadUrl.includes("signer-un-document"),
      ),
    ).toBe(false);
  });

  it("fails closed when only action links remain after the exclusion", async () => {
    const fixture = await atexoQueryDiscovery();

    expect(() =>
      parseMaximilienListing({
        ...fixture,
        listingHtml:
          '<a href="/entreprise/signer-un-document">Signer un document</a>',
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
