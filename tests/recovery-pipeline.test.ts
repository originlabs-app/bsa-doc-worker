import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { AdapterDiscovery } from "../src/ports.js";
import type {
  MatchEvidence,
  RecoveryTarget,
} from "../src/recovery/contracts.js";
import { RecoveryTooLargeError } from "../src/recovery/contracts.js";
import {
  createRecoveryDocumentPipeline,
  type RecoveryObjectStorage,
} from "../src/recovery/pipeline.js";

const target: RecoveryTarget = {
  tenderId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  title: "AO test",
  buyerName: "Ville test",
  reference: "REF-42",
  buyerProfileLink: "https://example.test/profile",
  lotTitles: [],
};

const match: MatchEvidence & { level: "exact" } = {
  level: "exact",
  referenceExact: true,
  buyerExact: true,
  buyerMatched: true,
  buyerTokenOverlap: 1,
  buyerSharedTokens: 1,
  titleMatched: true,
  titlePrefixMatch: true,
  titleJaccard: 1,
  lotTokenHits: 0,
  lotTitleMatches: 0,
  deadlineStatus: "coherent",
  placeUmbrellaCompatible: false,
  candidate: {
    portal: "place",
    canonicalTitle: target.title,
    reference: target.reference,
    buyerName: target.buyerName,
    consultationUrl:
      "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/42",
  },
};

function discovery(fileNames = ["DCE.pdf"]): AdapterDiscovery {
  const ephemeralAttachments = fileNames.map((fileName, index) => ({
    stableId: `piece-${index + 1}`,
    fileName,
    kind: "pdf" as const,
    expectedSize: null,
    sourcePlatform: "place" as const,
    downloadUrl:
      `https://www.marches-publics.gouv.fr/document/download/piece-${index + 1}`,
    requestHeaders: {},
  }));
  return {
    safeManifest: {
      consultationId: "42",
      selectedLots: ["all"],
      attachments: ephemeralAttachments.map(
        ({ stableId, fileName, kind, expectedSize }) => ({
          stableId,
          fileName,
          kind,
          expectedSize,
        }),
      ),
    },
    ephemeralAttachments,
  };
}

function storage() {
  const value: RecoveryObjectStorage = {
    upload: vi.fn(async () => ({ created: true })),
    remove: vi.fn(async () => undefined),
  };
  return value;
}

describe("createRecoveryDocumentPipeline", () => {
  it("quarantines all files, gives duplicate names stable suffixes and uploads once", async () => {
    const objectStorage = storage();
    const fetcher = vi.fn(async () =>
      new Response(Buffer.from("%PDF-1.7\nfixture"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    const pipeline = createRecoveryDocumentPipeline({
      storage: objectStorage,
      fetcher,
      maxBytes: 256 * 1024 * 1024,
    });

    const prepared = await pipeline.fetchAndUpload({
      target,
      match,
      discovery: discovery(["DCE.pdf", "DCE.pdf"]),
    });

    expect(prepared.documents.map(({ fileName }) => fileName)).toEqual([
      "DCE.pdf",
      "DCE-piece-2.pdf",
    ]);
    expect(objectStorage.upload).toHaveBeenCalledTimes(2);
    expect(prepared.documents[0]?.sourceReference).toBe("place:42:piece-1");
    await prepared.rollback();
    expect(objectStorage.remove).toHaveBeenCalledWith(
      prepared.documents.map(({ objectPath }) => objectPath),
    );
    await prepared.dispose();
  });

  it("records a streamed overflow as too_large and never uploads", async () => {
    const objectStorage = storage();
    const body = Readable.toWeb(
      Readable.from([
        Buffer.from("%PDF-1.7\n"),
        Buffer.alloc(256, "a"),
      ]),
    );
    const pipeline = createRecoveryDocumentPipeline({
      storage: objectStorage,
      fetcher: vi.fn(async () =>
        new Response(body as never, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      ),
      maxBytes: 100,
    });

    await expect(
      pipeline.fetchAndUpload({ target, match, discovery: discovery() }),
    ).rejects.toBeInstanceOf(RecoveryTooLargeError);
    expect(objectStorage.upload).not.toHaveBeenCalled();
  });

  it("removes only objects created before a later upload failure", async () => {
    const objectStorage = storage();
    vi.mocked(objectStorage.upload)
      .mockResolvedValueOnce({ created: true })
      .mockRejectedValueOnce(new Error("storage failed"));
    const pipeline = createRecoveryDocumentPipeline({
      storage: objectStorage,
      fetcher: vi.fn(async () =>
        new Response(Buffer.from("%PDF-1.7\nfixture"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      ),
      maxBytes: 1_000,
    });

    const error = await pipeline.fetchAndUpload({
        target,
        match,
        discovery: discovery(["one.pdf", "two.pdf"]),
      }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      reasonCode: "RECOVERY_STORAGE_UPLOAD_FAILED",
      failureStage: "upload",
      failureType: "storage",
      retryable: true,
    });
    expect(objectStorage.remove).toHaveBeenCalledWith([
      `${target.companyId}/${target.tenderId}/one.pdf`,
    ]);
  });

  it("rejects a traversal-shaped manifest identity before opening quarantine", async () => {
    const objectStorage = storage();
    const unsafe = discovery();
    unsafe.safeManifest.attachments[0]!.stableId = "../../escape";
    unsafe.ephemeralAttachments[0]!.stableId = "../../escape";
    const pipeline = createRecoveryDocumentPipeline({
      storage: objectStorage,
      fetcher: vi.fn(),
      maxBytes: 1_000,
    });

    const error = await pipeline
      .fetchAndUpload({ target, match, discovery: unsafe })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      reasonCode: "RECOVERY_MANIFEST_MISMATCH",
      failureStage: "manifest",
      failureType: "validation",
      retryable: false,
    });
    expect(objectStorage.upload).not.toHaveBeenCalled();
  });
});
