import { describe, expect, it, vi } from "vitest";

import type { WorkerLogger } from "../src/logger.js";
import { runReaderCli } from "../src/reader/cli.js";
import type { ReaderMode } from "../src/reader/config.js";
import type { ReaderPipelineDependencies } from "../src/reader/pipeline.js";

describe("runReaderCli", () => {
  it("starts safely off without constructing external clients", async () => {
    const dependencyFactory = vi.fn();
    const logger = { info: vi.fn() } satisfies WorkerLogger;

    await expect(
      runReaderCli({}, { logger, dependencyFactory, installSignalHandlers: false }),
    ).resolves.toBe(0);
    expect(dependencyFactory).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("reader_stopped", {
      mode: "off",
      reason: "READER_MODE_OFF",
    });
  });

  it("logs the release sha provenance in reader_started", async () => {
    const logger = { info: vi.fn() } satisfies WorkerLogger;
    const dependencies = {
      workerId: "reader:test",
    } as ReaderPipelineDependencies;
    const dependencyFactory = vi.fn(() => dependencies);
    const service = vi.fn(async () => ({
      mode: "dry_run" as const,
      ticks: 1,
      claimed: 0,
    }));

    await expect(
      runReaderCli(
        {
          READER_MODE: "dry_run",
          WORKER_RELEASE_SHA: "abc1234",
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role",
          OPENROUTER_API_KEY: "openrouter",
          NUKEMA_USERNAME: "reader",
          NUKEMA_PASSWORD: "password",
        },
        { logger, dependencyFactory, service, installSignalHandlers: false },
      ),
    ).resolves.toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      "reader_started",
      expect.objectContaining({ release: "abc1234" }),
    );
  });

  it("logs release as unknown when WORKER_RELEASE_SHA is absent", async () => {
    const logger = { info: vi.fn() } satisfies WorkerLogger;
    const dependencies = {
      workerId: "reader:test",
    } as ReaderPipelineDependencies;
    const dependencyFactory = vi.fn(() => dependencies);
    const service = vi.fn(async () => ({
      mode: "dry_run" as const,
      ticks: 1,
      claimed: 0,
    }));

    await expect(
      runReaderCli(
        {
          READER_MODE: "dry_run",
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-role",
          OPENROUTER_API_KEY: "openrouter",
          NUKEMA_USERNAME: "reader",
          NUKEMA_PASSWORD: "password",
        },
        { logger, dependencyFactory, service, installSignalHandlers: false },
      ),
    ).resolves.toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      "reader_started",
      expect.objectContaining({ release: "unknown" }),
    );
  });

  it("fails the live kill-switch closed when its value becomes invalid", async () => {
    const env: Record<string, string | undefined> = {
      READER_MODE: "dry_run",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      OPENROUTER_API_KEY: "openrouter",
      NUKEMA_USERNAME: "reader",
      NUKEMA_PASSWORD: "password",
    };
    let liveMode: (() => ReaderMode) | undefined;
    const dependencies = {
      workerId: "reader:test",
    } as ReaderPipelineDependencies;
    const dependencyFactory = vi.fn((_config, _logger, modeSource) => {
      liveMode = modeSource;
      return dependencies;
    });
    const service = vi.fn(async () => {
      env.READER_MODE = "unexpected";
      expect(liveMode?.()).toBe("off");
      return { mode: "dry_run" as const, ticks: 1, claimed: 0 };
    });

    await expect(
      runReaderCli(env, {
        dependencyFactory,
        service,
        installSignalHandlers: false,
      }),
    ).resolves.toBe(0);
    expect(service).toHaveBeenCalledTimes(1);
  });
});
