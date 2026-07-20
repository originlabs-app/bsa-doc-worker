import { describe, expect, it, vi } from "vitest";

import type { WorkerLogger } from "../src/logger.js";
import { runAnalyzeCli } from "../src/analyze/cli.js";
import type { AnalyzeOneShotDependencies } from "../src/analyze/wiring.js";

describe("runAnalyzeCli", () => {
  it("stays off without constructing Supabase or OpenRouter dependencies", async () => {
    const dependencyFactory = vi.fn();
    const runner = vi.fn();
    const logger = { info: vi.fn() } satisfies WorkerLogger;

    await expect(runAnalyzeCli({}, {
      dependencyFactory,
      runner,
      logger,
    })).resolves.toBe(0);
    expect(dependencyFactory).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("analyze_stopped", {
      mode: "off",
      reason: "ANALYZE_MODE_OFF",
    });
  });

  it("runs exactly one shadow pass and exits", async () => {
    const dependencies = {} as AnalyzeOneShotDependencies;
    const dependencyFactory = vi.fn(() => dependencies);
    const runner = vi.fn().mockResolvedValue({
      mode: "shadow",
      status: "analyzed",
      queueId: "queue-1",
      tenderId: "tender-1",
      existingScore: 72,
      analyzedScore: 100,
      delta: 28,
      result: {},
    });

    await expect(runAnalyzeCli({
      ANALYZE_MODE: "shadow",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      OPENROUTER_API_KEY: "openrouter",
    }, { dependencyFactory, runner })).resolves.toBe(0);

    expect(dependencyFactory).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "shadow" }),
      dependencies,
    );
  });

  it("fails closed when active configuration is incomplete", async () => {
    const dependencyFactory = vi.fn();

    await expect(runAnalyzeCli({
      ANALYZE_MODE: "shadow",
      OPENROUTER_API_KEY: "openrouter",
    }, { dependencyFactory })).resolves.toBe(1);
    expect(dependencyFactory).not.toHaveBeenCalled();
  });

  it("rejects a non-local Supabase URL without HTTPS", async () => {
    const dependencyFactory = vi.fn();

    await expect(runAnalyzeCli({
      ANALYZE_MODE: "shadow",
      SUPABASE_URL: "http://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      OPENROUTER_API_KEY: "openrouter",
    }, { dependencyFactory })).resolves.toBe(1);
    expect(dependencyFactory).not.toHaveBeenCalled();
  });
});
