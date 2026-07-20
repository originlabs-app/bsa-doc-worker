import { describe, expect, it } from "vitest";

import {
  loadWorkerConfig,
  missingRealSecretsForPlatform,
  parseWorkerSecretEnv,
} from "../src/config.js";
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

  it("requires only the credentials for the routed real portal", () => {
    const config = loadWorkerConfig({
      RECOVERY_MODE: "dry_run",
      RECOVERY_PROVIDER: "real",
      BROWSERLESS_TOKEN: "fixture-token",
      PLACE_PORTAL_EMAIL: "place@example.test",
      PLACE_PORTAL_PASSWORD: "place-password",
    });

    expect(missingRealSecretsForPlatform(config, "place")).toEqual([]);
    expect(missingRealSecretsForPlatform(config, "maximilien")).toEqual([
      "MAXIMILIEN_PORTAL_EMAIL",
      "MAXIMILIEN_PORTAL_PASSWORD",
    ]);
    expect(missingRealSecretsForPlatform(config, "aw_solutions")).toEqual([
      "AW_PORTAL_EMAIL",
      "AW_PORTAL_PASSWORD",
    ]);
  });
});

describe("parseWorkerSecretEnv", () => {
  it("keeps comment markers inside an unquoted worker secret", () => {
    const parsed = parseWorkerSecretEnv(
      "AW_PORTAL_EMAIL=operator@example.test\nAW_PORTAL_PASSWORD=fixture#part\n",
    );

    expect(parsed).toEqual({
      AW_PORTAL_EMAIL: "operator@example.test",
      AW_PORTAL_PASSWORD: "fixture#part",
    });
  });

  it("rejects duplicate worker secrets", () => {
    expect(() =>
      parseWorkerSecretEnv(
        "AW_PORTAL_PASSWORD=first\nAW_PORTAL_PASSWORD=second\n",
      ),
    ).toThrow("DUPLICATE_WORKER_SECRET");
  });

  it("loads PLACE and Maximilien credentials without exposing their values", () => {
    const parsed = parseWorkerSecretEnv(
      [
        "PLACE_PORTAL_EMAIL=place@example.test",
        "PLACE_PORTAL_PASSWORD=place#fixture",
        "MAXIMILIEN_PORTAL_EMAIL=max@example.test",
        "MAXIMILIEN_PORTAL_PASSWORD=max#fixture",
      ].join("\n"),
    );

    expect(Object.keys(parsed).sort()).toEqual([
      "MAXIMILIEN_PORTAL_EMAIL",
      "MAXIMILIEN_PORTAL_PASSWORD",
      "PLACE_PORTAL_EMAIL",
      "PLACE_PORTAL_PASSWORD",
    ]);
  });
});
