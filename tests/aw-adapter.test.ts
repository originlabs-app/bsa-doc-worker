import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  AwSolutionsAdapter,
  parseAwListing,
  type AwBrowserDiscovery,
  type AwBrowserSession,
} from "../src/adapters/aw-solutions.js";
import type { RecoveryRequest } from "../src/contracts.js";

const request: RecoveryRequest = {
  jobId: "job-26dsp03",
  tenderId: "tender-26dsp03",
  sourceField: "link_to_buyer_profile",
  providedUrl:
    "https://www.marches-publics.info/consultation?IDM=1841450",
  requestedLots: { kind: "all" },
};

async function fixtureHtml(): Promise<string> {
  return readFile(new URL("fixtures/aws/listing.html", import.meta.url), "utf8");
}

describe("parseAwListing", () => {
  it("keeps only proven AW attachment routes and strips signed URLs", async () => {
    const discovery = parseAwListing({
      consultationUrl: request.providedUrl,
      consultationId: "1841450",
      selectedLots: ["all"],
      listingHtml: await fixtureHtml(),
      cookieHeader: "CFID=fixture; CFTOKEN=fixture",
      userAgent: "fixture-agent",
    });

    expect(discovery.safeManifest.attachments).toHaveLength(3);
    expect(discovery.safeManifest.attachments.map((item) => item.fileName)).toEqual([
      "AAPC 26DSP03.pdf",
      "Lot 01.zip",
      "Avis PDF.pdf",
    ]);
    expect(JSON.stringify(discovery.safeManifest)).not.toContain("signature");
    expect(JSON.stringify(discovery.safeManifest)).not.toContain("CFID");
    expect(discovery.ephemeralAttachments[0]?.downloadUrl).toContain(
      "signature=fixture-only",
    );
  });

  it("derives stable identities without signed query parameters", async () => {
    const html = await fixtureHtml();
    const first = parseAwListing({
      consultationUrl: request.providedUrl,
      consultationId: "1841450",
      selectedLots: ["all"],
      listingHtml: html,
      cookieHeader: "",
      userAgent: "fixture-agent",
    });
    const second = parseAwListing({
      consultationUrl: request.providedUrl,
      consultationId: "1841450",
      selectedLots: ["all"],
      listingHtml: html.replaceAll("fixture-only", "rotated-signature"),
      cookieHeader: "",
      userAgent: "fixture-agent",
    });

    expect(second.safeManifest.attachments.map((item) => item.stableId)).toEqual(
      first.safeManifest.attachments.map((item) => item.stableId),
    );
  });
});

describe("AwSolutionsAdapter", () => {
  it("returns the safe manifest produced by a browser-only discovery session", async () => {
    const browserDiscovery: AwBrowserDiscovery = {
      consultationUrl: request.providedUrl,
      consultationId: "1841450",
      selectedLots: ["all"],
      listingHtml: await fixtureHtml(),
      cookieHeader: "CFID=fixture; CFTOKEN=fixture",
      userAgent: "fixture-agent",
    };
    const session: AwBrowserSession = {
      discover: async () => browserDiscovery,
    };

    const discovery = await new AwSolutionsAdapter(session).discover(request);

    expect(discovery.safeManifest.consultationId).toBe("1841450");
    expect(discovery.safeManifest.attachments).toHaveLength(3);
  });
});
