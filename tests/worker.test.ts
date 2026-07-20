import { describe, expect, it, vi } from "vitest";

import { AwAdapterError } from "../src/adapters/aw-solutions.js";
import { PortalAdapterError } from "../src/adapters/portal-adapter-error.js";
import {
  AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_ATTEMPT,
  AwCaptchaSolveBudget,
} from "../src/adapters/playwright-aw-session.js";
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

  it("dispatches PLACE without invoking the AW adapter", async () => {
    const awAdapter = successfulAdapter();
    const placeAdapter = successfulAdapter();
    const report = await runRecovery(
      requestFor("https://www.marches-publics.gouv.fr/consultation/123"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      { awAdapter, placeAdapter },
    );

    expect(report.status).toBe("manifest_ready");
    expect(awAdapter.discover).not.toHaveBeenCalled();
    expect(placeAdapter.discover).toHaveBeenCalledOnce();
  });

  it("dispatches Maximilien without invoking the AW adapter", async () => {
    const awAdapter = successfulAdapter();
    const maximilienAdapter = successfulAdapter();
    const report = await runRecovery(
      requestFor("https://marches.maximilien.fr/consultation/456"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      { awAdapter, maximilienAdapter },
    );

    expect(report.status).toBe("manifest_ready");
    expect(awAdapter.discover).not.toHaveBeenCalled();
    expect(maximilienAdapter.discover).toHaveBeenCalledOnce();
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

    expect(report.status).toBe("recovery_blocked");
    expect(report.reasonCode).toBe("RETRY_CAP_REACHED");
    expect(report.attemptsUsed).toBe(2);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("keeps the AW CAPTCHA solve budget per attempt and blocks recovery at the cap", async () => {
    const budgets: AwCaptchaSolveBudget[] = [];
    const discover = vi.fn(async () => {
      const budget = new AwCaptchaSolveBudget();
      budgets.push(budget);
      budget.commitSolve();
      // A second unsolved CAPTCHA in the same attempt exceeds the budget.
      budget.commitSolve();
      throw new Error("unreachable: the budget must fail first");
    });
    const report = await runRecovery(
      requestFor("https://www.marches-publics.info/consultation?IDM=1848852"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      { awAdapter: { discover } },
    );

    expect(report.status).toBe("recovery_blocked");
    expect(report.reasonCode).toBe("RETRY_CAP_REACHED");
    expect(report.attemptsUsed).toBe(2);
    expect(budgets).toHaveLength(2);
    for (const budget of budgets) {
      expect(budget.unitsCommitted).toBeLessThanOrEqual(
        AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_ATTEMPT,
      );
    }
  });

  it("logs the static adapter error detail for each failed attempt", async () => {
    const info = vi.fn();
    const discover = vi.fn(async () => {
      throw new AwAdapterError(
        "ADAPTER_FAILURE",
        false,
        "AW select-all control is unavailable",
      );
    });
    const report = await runRecovery(
      requestFor("https://www.marches-publics.info/consultation?IDM=1848459"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      { awAdapter: { discover }, logger: { info } },
    );

    expect(report.status).toBe("failed");
    expect(info).toHaveBeenCalledWith("adapter_attempt_failed", {
      jobId: "job-1",
      tenderId: "tender-1",
      platform: "aw_solutions",
      attempt: 1,
      reasonCode: "ADAPTER_FAILURE",
      retryable: false,
      errorDetail: "AW select-all control is unavailable",
    });
  });

  it("blocks a rejected AW login after one attempt", async () => {
    const discover = vi.fn(async () => {
      throw new AwAdapterError(
        "AW_AUTHENTICATION_REJECTED",
        false,
        "fixture failure",
      );
    });
    const report = await runRecovery(
      requestFor("https://www.marches-publics.info/consultation?IDM=1"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      { awAdapter: { discover } },
    );

    expect(report.status).toBe("recovery_blocked");
    expect(report.reasonCode).toBe("AW_AUTHENTICATION_REJECTED");
    expect(report.attemptsUsed).toBe(1);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("blocks a portal discovery failure without changing AW semantics", async () => {
    const discover = vi.fn(async () => {
      throw new PortalAdapterError(
        "PORTAL_DISCOVERY_BLOCKED",
        false,
        "fixture failure",
      );
    });
    const report = await runRecovery(
      requestFor("https://marches.maximilien.fr/consultation/456"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      {
        awAdapter: successfulAdapter(),
        maximilienAdapter: { discover },
      },
    );

    expect(report.status).toBe("recovery_blocked");
    expect(report.reasonCode).toBe("PORTAL_DISCOVERY_BLOCKED");
    expect(report.attemptsUsed).toBe(1);
  });

  it("caps retryable Maximilien failures at two attempts", async () => {
    const discover = vi.fn(async () => {
      throw new PortalAdapterError(
        "CAPTCHA_UNSOLVED",
        true,
        "fixture failure",
      );
    });
    const report = await runRecovery(
      requestFor("https://marches.maximilien.fr/consultation/456"),
      loadWorkerConfig({ RECOVERY_MODE: "dry_run" }),
      {
        awAdapter: successfulAdapter(),
        maximilienAdapter: { discover },
      },
    );

    expect(report.status).toBe("recovery_blocked");
    expect(report.reasonCode).toBe("RETRY_CAP_REACHED");
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
