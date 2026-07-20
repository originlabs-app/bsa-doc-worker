import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  PlaceAdapter,
  parsePlaceListing,
  type PlaceBrowserDiscovery,
} from "../src/adapters/place.js";
import { MockPlaceBrowserSession } from "../src/adapters/mock-place-session.js";

async function fixtureDiscovery(): Promise<PlaceBrowserDiscovery> {
  return {
    consultationUrl:
      "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/3036454",
    consultationId: "3036454",
    selectedLots: ["all"],
    listingHtml: await readFile(
      new URL("fixtures/place/manifest.html", import.meta.url),
      "utf8",
    ),
    cookieHeader: "PLACESESSION=fixture-only",
    userAgent: "bsa-place-fixture",
  };
}

describe("parsePlaceListing", () => {
  it("projects a safe manifest from the sanitized PLACE fixture", async () => {
    const discovery = parsePlaceListing(await fixtureDiscovery());

    expect(discovery.safeManifest).toMatchObject({
      consultationId: "3036454",
      selectedLots: ["all"],
      attachments: [
        {
          fileName: "Règlement de consultation.pdf",
          kind: "pdf",
          expectedSize: 4096,
        },
        {
          fileName: "DCE complet.zip",
          kind: "zip",
          expectedSize: 8192,
        },
      ],
    });
    expect(discovery.ephemeralAttachments).toHaveLength(2);
    expect(JSON.stringify(discovery.safeManifest)).not.toContain("signature");
    expect(JSON.stringify(discovery.safeManifest)).not.toContain("token");
  });

  it("fails closed when PLACE exposes no allowlisted attachment", async () => {
    const fixture = await fixtureDiscovery();

    expect(() =>
      parsePlaceListing({
        ...fixture,
        listingHtml:
          '<a href="https://attacker.invalid/document.pdf">Document</a>',
      }),
    ).toThrow("PLACE manifest did not expose an allowlisted attachment");
  });

  it("manifests the witness consultation pieces from Atexo query-string links", async () => {
    const discovery = parsePlaceListing({
      consultationUrl:
        "https://www.marches-publics.gouv.fr/index.php?page=Entreprise.EntrepriseDetailsConsultation&id=3040234&orgAcronyme=fixture",
      consultationId: "3040234",
      selectedLots: ["all"],
      listingHtml: await readFile(
        new URL("fixtures/place/manifest-atexo-query.html", import.meta.url),
        "utf8",
      ),
      cookieHeader: "PLACESESSION=fixture-only",
      userAgent: "bsa-place-fixture",
    });

    expect(discovery.safeManifest.attachments).toEqual([
      expect.objectContaining({
        fileName: "Règlement de consultation - 474,21 Ko",
      }),
      expect.objectContaining({
        fileName: "Dossier de consultation - 3,98 Mo",
      }),
    ]);
    expect(JSON.stringify(discovery.safeManifest)).not.toContain(
      "Signer un document",
    );
  });
});

describe("MockPlaceBrowserSession", () => {
  it("discovers a manifest without credentials or network", async () => {
    const adapter = new PlaceAdapter(new MockPlaceBrowserSession());
    const discovery = await adapter.discover({
      jobId: "job-place",
      tenderId: "tender-place",
      sourceField: "link_to_buyer_profile",
      providedUrl:
        "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/3036454",
      requestedLots: { kind: "all" },
    });

    expect(discovery.safeManifest.attachments).toHaveLength(2);
  });
});
