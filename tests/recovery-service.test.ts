import { describe, expect, it, vi } from "vitest";

import { AwAdapterError } from "../src/adapters/aw-solutions.js";
import { DownloadError } from "../src/download.js";
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
  lotTitles: [],
  deadlineAt: "2026-09-30T10:00:00.000Z",
  recoveryDisposition: "recoverable",
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
          canonicalTitle: "Rénovation énergétique de l'école Jean Moulin",
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

  it("records an exact external AW listing as blocked and never discovers it", async () => {
    const fixture = dependencies();
    const externalCandidate: PortalCandidate = {
      ...exactCandidate,
      portal: "aw_solutions",
      consultationUrl:
        "https://www.marches-publics.info/Annonces/MPI-pub-20262001118.htm",
      recoveryDisposition: "external_blocked",
      blockedExternalHost: "plateforme.alsacemarchespublics.eu",
    };
    vi.mocked(fixture.deps.searchPortal).mockImplementation(async (portal) => ({
      portal,
      candidates: portal === "aw_solutions" ? [externalCandidate] : [],
      ...(portal === "aw_solutions"
        ? { blockedExternalHost: "plateforme.alsacemarchespublics.eu" }
        : {}),
    }));

    const report = await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      fixture.deps,
    );

    expect(fixture.store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        portal: "aw_solutions",
        decision: "exact",
      }),
    );
    expect(fixture.deps.discover).not.toHaveBeenCalled();
    expect(fixture.pipeline.fetchAndUpload).not.toHaveBeenCalled();
    expect(report).toMatchObject({ nBlocked: 1, nFound: 0 });
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

  it("records a portal outage as error instead of a false not_found", async () => {
    const fixture = dependencies({ candidates: [] });
    vi.mocked(fixture.deps.searchPortal).mockImplementation(async (portal) => ({
      portal,
      candidates: [],
      errorCode: "PORTAL_SEARCH_FAILED",
    }));

    const report = await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      fixture.deps,
    );

    expect(fixture.store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", decision: "error" }),
    );
    expect(report.nError).toBe(1);
    expect(report.nNotFound).toBe(0);
  });
});

describe("runRecoverySweep failure evidence", () => {
  it("records the structured CAPTCHA failure in evidence and the completion event", async () => {
    const fixture = dependencies();
    const info = vi.fn();
    let captchaUnits = 0;
    vi.mocked(fixture.deps.discover).mockImplementationOnce(async () => {
      captchaUnits = 10;
      throw new AwAdapterError(
        "CAPTCHA_UNSOLVED",
        true,
        "Browserless did not solve the AW CAPTCHA (captcha_not_recognized_by_browserless)",
      );
    });
    const deps = {
      ...fixture.deps,
      captchaUnits: () => captchaUnits,
      logger: { info },
    };

    const report = await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      deps,
    );

    expect(report.nBlocked).toBe(1);
    const failure = {
      stage: "captcha",
      type: "captcha",
      reason_code: "CAPTCHA_UNSOLVED",
      retryable: true,
      message: expect.stringContaining(
        "captcha_not_recognized_by_browserless",
      ) as unknown as string,
      units_spent: 10,
    };
    expect(fixture.store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        decision: "blocked",
        evidence: expect.objectContaining({
          failure,
        }),
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "recovery_attempt_completed",
      expect.objectContaining({
        status: "blocked",
        failure,
        units: 10,
      }),
    );
  });

  it("records and redacts a swallowed identification network failure", async () => {
    const fixture = dependencies();
    const info = vi.fn();
    vi.mocked(fixture.deps.searchPortal).mockRejectedValue(
      new Error(
        "fetch failed at https://www.marches-publics.info/Annonces/lister?token=must-not-leak",
      ),
    );

    const report = await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      { ...fixture.deps, logger: { info } },
    );

    expect(report.nError).toBe(1);
    const failure = {
      stage: "identification",
      type: "network",
      reason_code: "PORTAL_SEARCH_FAILED",
      retryable: true,
      message: expect.stringContaining("fetch failed") as unknown as string,
      units_spent: 0,
    };
    expect(fixture.store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        evidence: expect.objectContaining({
          failure,
        }),
      }),
    );
    const finalized = vi.mocked(fixture.store.finalize).mock.calls[0]?.[0];
    expect(JSON.stringify(finalized?.evidence)).not.toContain("must-not-leak");
    expect(info).toHaveBeenCalledWith(
      "recovery_attempt_completed",
      expect.objectContaining({ status: "error", failure }),
    );
  });

  it("documents an external buyer-profile block at identification", async () => {
    const fixture = dependencies();
    const info = vi.fn();
    const externalCandidate: PortalCandidate = {
      ...exactCandidate,
      portal: "aw_solutions",
      consultationUrl:
        "https://www.marches-publics.info/Annonces/MPI-pub-20262001118.htm",
      recoveryDisposition: "external_blocked",
      blockedExternalHost: "plateforme.alsacemarchespublics.eu",
    };
    vi.mocked(fixture.deps.searchPortal).mockImplementation(async (portal) => ({
      portal,
      candidates: portal === "aw_solutions" ? [externalCandidate] : [],
      ...(portal === "aw_solutions"
        ? { blockedExternalHost: "plateforme.alsacemarchespublics.eu" }
        : {}),
    }));

    await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      { ...fixture.deps, logger: { info } },
    );

    const failure = {
      stage: "identification",
      type: "external_portal",
      reason_code: "UNSUPPORTED_PORTAL",
      retryable: false,
      message: expect.stringContaining(
        "plateforme.alsacemarchespublics.eu",
      ) as unknown as string,
      units_spent: 0,
    };
    expect(fixture.store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "blocked",
        evidence: expect.objectContaining({ failure }),
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "recovery_attempt_completed",
      expect.objectContaining({ status: "blocked", failure }),
    );
  });

  it("keeps CAPTCHA units scoped to the attempt that spent them", async () => {
    const fixture = dependencies();
    const secondTarget = { ...target, tenderId: "tender-2" };
    vi.mocked(fixture.store.listEligible).mockResolvedValueOnce([
      target,
      secondTarget,
    ]);
    let captchaUnits = 0;
    vi.mocked(fixture.deps.discover)
      .mockImplementationOnce(async () => {
        captchaUnits = 10;
        throw new AwAdapterError("CAPTCHA_UNSOLVED", true, "captcha failed");
      })
      .mockRejectedValueOnce(
        new AwAdapterError(
          "AW_AUTHENTICATION_REJECTED",
          false,
          "login rejected",
        ),
      );

    await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      { ...fixture.deps, captchaUnits: () => captchaUnits },
    );

    const failures = vi.mocked(fixture.store.finalize).mock.calls.map(
      ([input]) => (input.evidence as { failure: { units_spent: number } })
        .failure,
    );
    expect(failures).toEqual([
      expect.objectContaining({ type: "captcha", units_spent: 10 }),
      expect.objectContaining({ type: "login", units_spent: 0 }),
    ]);
  });

  it("classifies a streamed network failure as download", async () => {
    const fixture = dependencies();
    vi.mocked(fixture.pipeline.fetchAndUpload).mockRejectedValueOnce(
      new DownloadError("incomplete", {
        type: "network",
        message: "Attachment request failed: socket hang up",
      }),
    );

    await runRecoverySweep(
      { mode: "apply", batchSize: 25 },
      fixture.deps,
    );

    expect(fixture.store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        evidence: expect.objectContaining({
          failure: expect.objectContaining({
            stage: "download",
            type: "network",
            reason_code: "DOWNLOAD_INCOMPLETE",
            units_spent: 0,
          }),
        }),
      }),
    );
  });
});
