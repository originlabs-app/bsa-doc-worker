import { describe, expect, it } from "vitest";

import { loadRecoveryConfig } from "../src/recovery/config.js";

describe("loadRecoveryConfig", () => {
  it("defaults to an inert one-shot worker", () => {
    expect(loadRecoveryConfig({})).toMatchObject({
      mode: "off",
      batchSize: 25,
      strongTitleJaccard: 0.5,
      titleOnlyJaccard: 0.7,
      cronGuard: "off",
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
});
