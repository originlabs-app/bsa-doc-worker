import { describe, expect, it, vi } from "vitest";

import type { WorkerLogger } from "../src/logger.js";
import {
  runRecoveryCli,
  type RecoveryDependencyFactory,
} from "../src/recovery/cli.js";
import type { RecoverySweepDependencies } from "../src/recovery/service.js";

function logger() {
  const info = vi.fn<WorkerLogger["info"]>();
  return { logger: { info } satisfies WorkerLogger, info };
}

const report = {
  mode: "dry_run" as const,
  nEligible: 1,
  nFound: 1,
  nAmbiguous: 0,
  nBlocked: 0,
  nNotFound: 0,
  nTooLarge: 0,
  nError: 0,
};

describe("runRecoveryCli", () => {
  it("defaults off without constructing any external dependency", async () => {
    const output = logger();
    const dependencyFactory = vi.fn<RecoveryDependencyFactory>();

    await expect(
      runRecoveryCli({}, { logger: output.logger, dependencyFactory }),
    ).resolves.toBe(0);
    expect(dependencyFactory).not.toHaveBeenCalled();
  });

  it("skips a duplicated UTC cron outside Paris 07h before any client", async () => {
    const output = logger();
    const dependencyFactory = vi.fn<RecoveryDependencyFactory>();

    await expect(
      runRecoveryCli(
        { RECOVERY_MODE: "apply" },
        {
          scheduled: true,
          now: () => new Date("2026-07-21T06:15:00Z"),
          logger: output.logger,
          dependencyFactory,
        },
      ),
    ).resolves.toBe(0);
    expect(dependencyFactory).not.toHaveBeenCalled();
    expect(output.info).toHaveBeenCalledWith(
      "recovery_skipped_wrong_hour",
      expect.objectContaining({ timezone: "Europe/Paris" }),
    );
  });

  it("runs a delayed scheduled dry-run at 07:17 Paris", async () => {
    const output = logger();
    const dependencies = {} as RecoverySweepDependencies;
    const dependencyFactory = vi.fn(() => dependencies);
    const runner = vi.fn(async () => report);

    await expect(
      runRecoveryCli(
        {
          RECOVERY_MODE: "dry_run",
          SUPABASE_URL: "https://project.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "fixture-secret",
        },
        {
          scheduled: true,
          now: () => new Date("2026-07-21T05:17:00Z"),
          logger: output.logger,
          dependencyFactory,
          runner,
        },
      ),
    ).resolves.toBe(0);
    expect(dependencyFactory).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledOnce();
  });

  it("fails apply before clients when required portal secrets are absent", async () => {
    const output = logger();
    const dependencyFactory = vi.fn<RecoveryDependencyFactory>();

    await expect(
      runRecoveryCli(
        {
          RECOVERY_MODE: "apply",
          SUPABASE_URL: "https://project.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "fixture-secret",
        },
        { logger: output.logger, dependencyFactory },
      ),
    ).resolves.toBe(1);
    expect(dependencyFactory).not.toHaveBeenCalled();
  });
});
