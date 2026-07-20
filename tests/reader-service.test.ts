import { describe, expect, it, vi } from "vitest";

import type { StructuredPdfClient } from "../src/llm/document-reader.js";
import type { WorkerLogger } from "../src/logger.js";
import type { ReaderConfig, ReaderMode } from "../src/reader/config.js";
import type {
  ReaderDocumentSource,
  ReaderPipelineDependencies,
  ReaderTickReport,
} from "../src/reader/pipeline.js";
import { runReaderService } from "../src/reader/service.js";
import type { ReaderStore } from "../src/reader/supabase.js";

function config(mode: ReaderMode): ReaderConfig {
  return {
    mode,
    batch: 2,
    model: "google/gemini-3.5-flash",
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role",
    openRouterApiKey: "openrouter",
    nukemaUsername: "reader",
    nukemaPassword: "password",
    maxBytes: 1024,
    maxModelBytes: 512,
    heartbeatMs: 10,
    pollMs: 1,
  };
}

function dependencies(modeSource?: () => ReaderMode): ReaderPipelineDependencies {
  return {
    store: {} as ReaderStore,
    source: {} as ReaderDocumentSource,
    llmClient: {} as StructuredPdfClient,
    workerId: "reader:test",
    ...(modeSource ? { modeSource } : {}),
  };
}

function tickReport(mode: ReaderMode, claimed: number): ReaderTickReport {
  return { mode, claimed, processed: claimed, failed: 0, released: 0, results: [] };
}

describe("runReaderService", () => {
  it("does not build queue activity when the reader starts off", async () => {
    const tick = vi.fn();

    await expect(
      runReaderService(config("off"), dependencies(), {
        signal: new AbortController().signal,
        tick,
      }),
    ).resolves.toEqual({ mode: "off", ticks: 0, claimed: 0 });
    expect(tick).not.toHaveBeenCalled();
  });

  it("runs dry_run exactly once and logs the complete tick report", async () => {
    const report = tickReport("dry_run", 2);
    const tick = vi.fn().mockResolvedValue(report);
    const logger = { info: vi.fn() } satisfies WorkerLogger;

    const result = await runReaderService(
      config("dry_run"),
      { ...dependencies(), logger },
      { signal: new AbortController().signal, tick },
    );

    expect(result).toEqual({ mode: "dry_run", ticks: 1, claimed: 2 });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("reader_dry_run_result", { report });
  });

  it("keeps apply running until the hot mode source becomes off", async () => {
    const modes: ReaderMode[] = ["apply", "apply", "apply", "off"];
    const modeSource = vi.fn(() => modes.shift() ?? "off");
    const tick = vi
      .fn()
      .mockResolvedValueOnce(tickReport("apply", 1))
      .mockResolvedValueOnce(tickReport("apply", 0));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await runReaderService(
      config("apply"),
      dependencies(modeSource),
      { signal: new AbortController().signal, tick, sleep },
    );

    expect(result).toEqual({ mode: "apply", ticks: 2, claimed: 1 });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
