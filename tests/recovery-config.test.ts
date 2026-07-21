import { describe, expect, it } from "vitest";

import {
  isParisCronWindow,
  loadRecoveryConfig,
} from "../src/recovery/config.js";

describe("loadRecoveryConfig", () => {
  it("defaults to an inert one-shot worker", () => {
    expect(loadRecoveryConfig({})).toMatchObject({
      mode: "off",
      batchSize: 25,
      strongTitleJaccard: 0.5,
      titleOnlyJaccard: 0.7,
      maxBytes: 256 * 1024 * 1024,
    });
  });

  it("validates the supervised threshold override", () => {
    expect(
      loadRecoveryConfig({ RECOVERY_STRONG_TITLE_JACCARD: "0.60" })
        .strongTitleJaccard,
    ).toBe(0.6);
    expect(() =>
      loadRecoveryConfig({ RECOVERY_STRONG_TITLE_JACCARD: "0.30" }),
    ).toThrow();
  });

  it("accepts a delayed Railway start anywhere during the Paris 07h hour", () => {
    expect(isParisCronWindow(new Date("2026-07-21T05:17:00Z"))).toBe(true);
    expect(isParisCronWindow(new Date("2026-07-21T04:59:59Z"))).toBe(false);
  });
});
