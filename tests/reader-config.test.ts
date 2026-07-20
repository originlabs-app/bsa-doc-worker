import { describe, expect, it } from "vitest";

import { loadReaderConfig } from "../src/reader/config.js";

describe("loadReaderConfig", () => {
  it("defaults to off without requiring any credential", () => {
    expect(loadReaderConfig({})).toMatchObject({
      mode: "off",
      batch: 2,
      model: "google/gemini-3.5-flash",
    });
  });

  it("requires worker credentials outside off mode", () => {
    expect(() => loadReaderConfig({ READER_MODE: "dry_run" })).toThrow(
      "SUPABASE_URL is required",
    );
  });

  it("accepts dry_run with the bounded batch and model override", () => {
    const config = loadReaderConfig({
      READER_MODE: "dry_run",
      READER_BATCH: "4",
      SUPABASE_URL: "https://example.supabase.co/",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      OPENROUTER_API_KEY: "openrouter",
      OPENROUTER_MODEL_EXTRACT: "vendor/model",
      NUKEMA_USERNAME: "reader",
      NUKEMA_PASSWORD: "password",
    });

    expect(config).toMatchObject({
      mode: "dry_run",
      batch: 4,
      supabaseUrl: "https://example.supabase.co",
      model: "vendor/model",
    });
  });
});
