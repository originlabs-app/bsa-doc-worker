import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "../src/config.js";
import { RecoveryRequestSchema } from "../src/contracts.js";

describe("RecoveryRequestSchema", () => {
  it("accepts one exact Nukema consultation URL", () => {
    const parsed = RecoveryRequestSchema.parse({
      jobId: "job-26dsp03",
      tenderId: "tender-26dsp03",
      sourceField: "link_to_buyer_profile",
      providedUrl: "https://www.marches-publics.info/consultation?IDM=1841450",
    });

    expect(parsed.requestedLots).toEqual({ kind: "all" });
    expect(parsed.providedUrl).toContain("IDM=1841450");
  });

  it("rejects non-HTTPS consultation URLs", () => {
    const parsed = RecoveryRequestSchema.safeParse({
      jobId: "job-1",
      tenderId: "tender-1",
      sourceField: "url_consultation",
      providedUrl: "http://www.marches-publics.info/consultation?IDM=1",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("loadWorkerConfig", () => {
  it("defaults to off and mock without requiring secrets", () => {
    const config = loadWorkerConfig({});

    expect(config.mode).toBe("off");
    expect(config.provider).toBe("mock");
    expect(config.missingRealSecrets).toEqual([]);
  });

  it("reports all missing real-provider secrets without throwing", () => {
    const config = loadWorkerConfig({
      RECOVERY_MODE: "dry_run",
      RECOVERY_PROVIDER: "real",
    });

    expect(config.missingRealSecrets).toEqual([
      "BROWSERLESS_TOKEN",
      "AW_PORTAL_EMAIL",
      "AW_PORTAL_PASSWORD",
    ]);
  });
});
