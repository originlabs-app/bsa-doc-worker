import { describe, expect, it, vi } from "vitest";

import type { AdapterDiscovery } from "../src/ports.js";
import type {
  PortalCandidate,
  RecoveryAttemptStore,
  RecoveryDocumentPipeline,
  RecoveryTarget,
} from "../src/recovery/contracts.js";
import { RecoveryTooLargeError } from "../src/recovery/contracts.js";
import { runRecoverySweep } from "../src/recovery/service.js";

const target: RecoveryTarget = {
  tenderId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  title: "Rénovation énergétique de l'école Jean Jaurès",
  buyerName: "Ville de Lyon",
  reference: "LYON-2026-042",
  buyerProfileLink: "https://achatpublic.com/consultation/example",
  lotTitles: [],
};

const exactCandidate: PortalCandidate = {
  portal: "place",
  canonicalTitle: target.title,
  reference: target.reference,
  buyerName: target.buyerName,
  consultationUrl:
    "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/42",
};

const discovery: AdapterDiscovery = {
  safeManifest: {
    consultationId: "42",
    selectedLots: ["all"],
    attachments: [
      {
        stableId: "piece-1",
        fileName: "DCE.zip",
        kind: "zip",
        expectedSize: 10,
      },
    ],
  },
  ephemeralAttachments: [],
};

function dependencies(options: { candidates?: PortalCandidate[] } = {}) {
  const store: RecoveryAttemptStore = {
    validateApplyReadiness: vi.fn(async () => undefined),
    listEligible: vi.fn(async () => [target]),
    reserve: vi.fn(async () => ({ attemptId: "attempt-1", attemptNumber: 1 })),
    finalize: vi.fn(async () => undefined),
    persistFound: vi.fn(async () => ({ insertedDocuments: 1, queueStatus: "queued" })),
  };
  const batch = {
    documents: [
      {
        fileName: "DCE.zip",
        objectPath: `${target.companyId}/${target.tenderId}/DCE.zip`,
        sourceUrl: exactCandidate.consultationUrl,
        sourceReference: "place:42:piece-1",
        bytes: 10,
        sha256: "a".repeat(64),
      },
    ],
    rollback: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const pipeline: RecoveryDocumentPipeline = {
    fetchAndUpload: vi.fn(async () => batch),
  };
  return {
    deps: {
      store,
      searchPortal: vi.fn(async (portal: PortalCandidate["portal"]) => ({
        portal,
        candidates: portal === "place" ? (options.candidates ?? [exactCandidate]) : [],
      })),
      discover: vi.fn(async () => discovery),
      pipeline,
    },
    store,
    pipeline,
    batch,
  };
}

describe("runRecoverySweep", () => {
  it("fails apply readiness before selection or portal traffic", async () => {
    const fixture = dependencies();
    vi.mocked(fixture.store.validateApplyReadiness).mockRejectedValueOnce(
      new Error("RECOVERY_SYSTEM_PROFILE_INVALID"),
    );

    await expect(
      runRecoverySweep({ mode: "apply", batchSize: 25 }, fixture.deps),
    ).rejects.toThrow("RECOVERY_SYSTEM_PROFILE_INVALID");
    expect(fixture.store.listEligible).not.toHaveBeenCalled();
    expect(fixture.deps.searchPortal).not.toHaveBeenCalled();
  });

  it("queries all three allowlisted portals in dry-run with zero writes or fetch", async () => {
    const fixture = dependencies();

    const report = await runRecoverySweep(
      { mode: "dry_run", batchSize: 25 },
      fixture.deps,
    );

    expect(fixture.deps.searchPortal).toHaveBeenCalledTimes(3);
    expect(fixture.deps.searchPortal).toHaveBeenCalledWith("aw_solutions", target);
    expect(fixture.deps.searchPortal).toHaveBeenCalledWith("place", target);
    expect(fixture.deps.searchPortal).toHaveBeenCalledWith("maximilien", target);
    expect(fixture.store.reserve).not.toHaveBeenCalled();
    expect(fixture.store.finalize).not.toHaveBeenCalled();
    expect(fixture.store.persistFound).not.toHaveBeenCalled();
    expect(fixture.deps.discover).not.toHaveBeenCalled();
    expect(fixture.pipeline.fetchAndUpload).not.toHaveBeenCalled();
    expect(report.nFound).toBe(1);
  });

  it("records a medium match as ambiguous and never fetches it", async () => {
    const fixture = dependencies({
      candidates: [
        {
          ...exactCandidate,
          reference: "different",
          canonicalTitle: "Rénovation partielle d'un gymnase",
        },
      ],
    });

    const report = await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      fixture.deps,
    );

    expect(fixture.store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ambiguous" }),
    );
    expect(fixture.deps.discover).not.toHaveBeenCalled();
    expect(fixture.pipeline.fetchAndUpload).not.toHaveBeenCalled();
    expect(report.nAmbiguous).toBe(1);
  });

  it("persists one exact manifest and disposes its quarantine", async () => {
    const fixture = dependencies();

    const report = await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      fixture.deps,
    );

    expect(fixture.store.persistFound).toHaveBeenCalledOnce();
    expect(fixture.batch.rollback).not.toHaveBeenCalled();
    expect(fixture.batch.dispose).toHaveBeenCalledOnce();
    expect(report.nFound).toBe(1);
  });

  it("records too_large without crashing the run", async () => {
    const fixture = dependencies();
    vi.mocked(fixture.pipeline.fetchAndUpload).mockRejectedValueOnce(
      new RecoveryTooLargeError(),
    );

    const report = await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      fixture.deps,
    );

    expect(fixture.store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "too_large" }),
    );
    expect(report.nTooLarge).toBe(1);
  });
});
