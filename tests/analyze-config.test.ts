import { describe, expect, it } from "vitest";

import { loadAnalyzeConfig } from "../src/analyze/index.js";

describe("loadAnalyzeConfig", () => {
  it("defaults to an inert analyst without requiring a secret", () => {
    expect(loadAnalyzeConfig({})).toEqual({
      mode: "off",
      model: "openai/gpt-5.6-terra",
      maxSteps: 8,
      maxOutputTokens: 8_192,
      deadlineMinDays: 15,
      openRouterApiKey: undefined,
    });
  });

  it("bounds the DLRO minimum window like the other operator overrides", () => {
    expect(loadAnalyzeConfig({ DLRO_MIN_DAYS: "10" }).deadlineMinDays).toBe(10);
    expect(() => loadAnalyzeConfig({ DLRO_MIN_DAYS: "366" })).toThrow(
      "DLRO_MIN_DAYS",
    );
    expect(() => loadAnalyzeConfig({ DLRO_MIN_DAYS: "abc" })).toThrow(
      "DLRO_MIN_DAYS",
    );
  });

  it("requires OpenRouter only when analysis is enabled", () => {
    expect(() => loadAnalyzeConfig({ ANALYZE_MODE: "shadow" })).toThrow(
      "OPENROUTER_API_KEY is required",
    );
  });

  it("rejects an operator override above the hard budgets", () => {
    expect(() =>
      loadAnalyzeConfig({
        ANALYZE_MODE: "shadow",
        OPENROUTER_API_KEY: "test",
        ANALYZE_MAX_STEPS: "13",
      })
    ).toThrow("ANALYZE_MAX_STEPS");
    expect(() =>
      loadAnalyzeConfig({
        ANALYZE_MODE: "shadow",
        OPENROUTER_API_KEY: "test",
        ANALYZE_MAX_OUTPUT_TOKENS: "8193",
      })
    ).toThrow("ANALYZE_MAX_OUTPUT_TOKENS");
  });
});
