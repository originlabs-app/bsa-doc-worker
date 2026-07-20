import { describe, expect, it, vi } from "vitest";

import { AwAdapterError } from "../src/adapters/aw-solutions.js";
import { loadWorkerConfig } from "../src/config.js";
import type { RecoveryRequest } from "../src/contracts.js";
import type { BuyerProfileAdapter } from "../src/ports.js";
import { runRecovery } from "../src/worker.js";

function requestFor(providedUrl: string): RecoveryRequest {
  return {
    jobId: "job-1",
    tenderId: "tender-1",
    sourceField: "link_to_buyer_profile",
    providedUrl,
    requestedLots: { kind: "all" },
  };
}

function successfulAdapter(): BuyerProfileAdapter {
  return {
    discover: vi.fn(async () => ({
      safeManifest: {
        consultationId: "1841450",
        selectedLots: ["all"],
        attachments: [
          {
            stableId: "attachment-1",
            fileName: "DCE.zip",
            kind: "zip" as const,
            expectedSize: 42,
          },
        ],
      },
      ephemeralAttachments: [
        {
          stableId: "attachment-1",
          fileName: "DCE.zip",
          kind: "zip" as const,
          expectedSize: 42,
          downloadUrl:
            "https://downloads.awsolutions.fr/dce/attachment/1?signature=secret",
          requestHeaders: {},
        },
      ],
    })),
  };
}

describe("runRecovery", () => {
  it("defaults off without invoking an adapter", async () => {
    const adapter = successfulAdapter();
    const report = await runRecovery(
      requestFor("https://www.marches-publics.info/consultation?IDM=1"),
      loadWorkerConfig({}),
      { awAdapter: adapter },
    );

    expect(report.status).toBe("off");
    expect(report.reasonCode).toBe("WORKER_OFF");
    expect(adapter.discover).not.toHaveBeenCalled();
  });

  it("returns a safe AW manifest in dry-run without exposing signed links", async () => {
    const report = await runRecovery(
      requestFor("https://www.marches-publics.info/consultation?IDM=1"),
      loadWorkerConfig({
        RECOVERY_MODE: "dry_run",
        RECOVERY_PROVIDER: "mock",
      }),
      { awAdapter: successfulAdapter() },
    );

    expect(report.status).toBe("manifest_ready");
    expect(report.attemptsUsed).toBe(1);
    expect(report.productionWriteOccurred).toBe(false);
    expect(JSON.stringify(report)).not.toContain("signature=secret");
  });

  it("classifies DILA without invoking Browserless", async () => {
    const adapter = successfulAdapter();
    const report = await runRecovery(
      requestFor("https://echanges.dila.gouv.fr/avis/123"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      { awAdapter: adapter },
    );

    expect(report.status).toBe("publication_only");
    expect(report.reasonCode).toBe("DILA_PUBLICATION_ONLY");
    expect(adapter.discover).not.toHaveBeenCalled();
  });

  it("blocks PLACE without invoking the AW adapter", async () => {
    const adapter = successfulAdapter();
    const report = await runRecovery(
      requestFor("https://www.marches-publics.gouv.fr/consultation/123"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      { awAdapter: adapter },
    );

    expect(report.status).toBe("recovery_blocked");
    expect(report.reasonCode).toBe("PLACE_V2_PENDING_VALIDATION");
    expect(adapter.discover).not.toHaveBeenCalled();
  });

  it("blocks apply before discovery or any write-capable dependency", async () => {
    const adapter = successfulAdapter();
    const report = await runRecovery(
      requestFor("https://www.marches-publics.info/consultation?IDM=1"),
      loadWorkerConfig({ RECOVERY_MODE: "apply" }),
      { awAdapter: adapter },
    );

    expect(report.status).toBe("recovery_blocked");
    expect(report.reasonCode).toBe("APPLY_NOT_AUTHORIZED");
    expect(adapter.discover).not.toHaveBeenCalled();
  });

  it("returns a clean block when real-provider secrets are absent", async () => {
    const adapter = successfulAdapter();
    const report = await runRecovery(
      requestFor("https://www.marches-publics.info/consultation?IDM=1"),
      loadWorkerConfig({
        RECOVERY_MODE: "dry_run",
        RECOVERY_PROVIDER: "real",
      }),
      { awAdapter: adapter },
    );

    expect(report.status).toBe("recovery_blocked");
    expect(report.reasonCode).toBe("MISSING_REAL_SECRETS");
    expect(adapter.discover).not.toHaveBeenCalled();
  });

  it("caps retryable adapter failures at two attempts per tender", async () => {
    const discover = vi.fn(async () => {
      throw new AwAdapterError("CAPTCHA_UNSOLVED", true, "fixture failure");
    });
    const report = await runRecovery(
      requestFor("https://www.marches-publics.info/consultation?IDM=1"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      { awAdapter: { discover } },
    );

    expect(report.status).toBe("failed");
    expect(report.reasonCode).toBe("RETRY_CAP_REACHED");
    expect(report.attemptsUsed).toBe(2);
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
