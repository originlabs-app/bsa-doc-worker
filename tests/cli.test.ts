import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  runCli,
  type CliAdapters,
  type CliIo,
} from "../src/cli.js";
import type { BuyerProfileAdapter } from "../src/ports.js";

function memoryIo(input: string) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    readInput: async () => input,
    stdout: { write: (chunk) => (stdout += String(chunk)) },
    stderr: { write: (chunk) => (stderr += String(chunk)) },
  };
  return {
    io,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("runCli", () => {
  it("runs the committed AW fixture in mock dry-run without secrets", async () => {
    const input = await readFile(
      new URL("fixtures/jobs.jsonl", import.meta.url),
      "utf8",
    );
    const memory = memoryIo(input);

    const exitCode = await runCli(
      ["--mode", "dry_run", "--provider", "mock", "--input", "fixture"],
      {},
      memory.io,
    );

    expect(exitCode).toBe(0);
    const report = JSON.parse(memory.stdout().trim()) as Record<string, unknown>;
    expect(report.status).toBe("manifest_ready");
    expect(report.productionWriteOccurred).toBe(false);
    expect(memory.stdout()).not.toContain("signature");
    expect(memory.stderr()).not.toContain("signature");
  });

  it("loads an explicit local worker env file without exposing its values", async () => {
    const input = await readFile(
      new URL("fixtures/jobs.jsonl", import.meta.url),
      "utf8",
    );
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      readInput: async (path) =>
        path === "local.env"
          ? "AW_PORTAL_PASSWORD=fixture#part\n"
          : input,
      stdout: { write: (chunk) => (stdout += String(chunk)) },
      stderr: { write: (chunk) => (stderr += String(chunk)) },
    };

    const exitCode = await runCli(
      [
        "--mode",
        "dry_run",
        "--provider",
        "mock",
        "--env-file",
        "local.env",
        "--input",
        "fixture",
      ],
      {},
      io,
    );

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("fixture#part");
    expect(stderr).not.toContain("fixture#part");
  });

  it("reports invalid input without echoing the hostile URL", async () => {
    const hostileUrl = "http://bad.test/path?token=must-not-leak";
    const memory = memoryIo(
      JSON.stringify({
        jobId: "job-1",
        tenderId: "tender-1",
        sourceField: "link_to_buyer_profile",
        providedUrl: hostileUrl,
      }),
    );

    const exitCode = await runCli(
      ["--mode", "dry_run", "--provider", "mock", "--input", "fixture"],
      {},
      memory.io,
    );

    expect(exitCode).toBe(1);
    expect(memory.stderr()).toContain("INVALID_INPUT");
    expect(memory.stderr()).not.toContain(hostileUrl);
  });

  it("routes PLACE and Maximilien through their mock adapters without secrets", async () => {
    const memory = memoryIo(
      [
        {
          jobId: "job-place",
          tenderId: "tender-place",
          sourceField: "link_to_buyer_profile",
          providedUrl:
            "https://www.marches-publics.gouv.fr/entreprise/consultation/3036454",
        },
        {
          jobId: "job-max",
          tenderId: "tender-max",
          sourceField: "url_consultation",
          providedUrl:
            "https://marches.maximilien.fr/entreprise/consultation/7788",
        },
      ]
        .map((request) => JSON.stringify(request))
        .join("\n"),
    );

    const exitCode = await runCli(
      ["--mode", "dry_run", "--provider", "mock", "--input", "fixture"],
      {},
      memory.io,
    );

    expect(exitCode).toBe(0);
    const reports = memory
      .stdout()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(reports.map(({ platform }) => platform)).toEqual([
      "place",
      "maximilien",
    ]);
    expect(reports.every(({ status }) => status === "manifest_ready")).toBe(
      true,
    );
    expect(memory.stdout()).not.toContain("fixture-only");
    expect(memory.stderr()).not.toContain("fixture-only");
  });

  it("reports missing real PLACE secrets cleanly without contacting Browserless", async () => {
    const memory = memoryIo(
      JSON.stringify({
        jobId: "job-place",
        tenderId: "tender-place",
        sourceField: "link_to_buyer_profile",
        providedUrl:
          "https://www.marches-publics.gouv.fr/entreprise/consultation/3036454",
      }),
    );
    const usageReaderFactory = vi.fn();

    const exitCode = await runCli(
      ["--mode", "dry_run", "--provider", "real", "--input", "fixture"],
      {},
      memory.io,
      { usageReaderFactory },
    );

    expect(exitCode).toBe(2);
    expect(memory.stdout()).toContain("MISSING_REAL_SECRETS");
    expect(usageReaderFactory).not.toHaveBeenCalled();
  });

  it("records one exact account-level Browserless delta around a real batch", async () => {
    const token = "browserless-secret";
    const memory = memoryIo(
      JSON.stringify({
        jobId: "job-aw",
        tenderId: "tender-aw",
        sourceField: "url_consultation",
        providedUrl:
          "https://marches-publics.info/Annonces/MPI-pub-2026-fixture.htm",
      }),
    );
    const fakeAdapter: BuyerProfileAdapter = {
      discover: vi.fn(async () => ({
        safeManifest: {
          consultationId: "fixture",
          selectedLots: ["all"],
          attachments: [],
        },
        ephemeralAttachments: [],
      })),
    };
    const adapters: CliAdapters = {
      awAdapter: fakeAdapter,
      placeAdapter: fakeAdapter,
      maximilienAdapter: fakeAdapter,
    };
    const snapshots = [
      {
        unitsUsed: 100,
        billingPeriodStart: "2026-07-01T00:00:00.000Z",
        billingPeriodEnd: "2026-08-01T00:00:00.000Z",
      },
      {
        unitsUsed: 113,
        billingPeriodStart: "2026-07-01T00:00:00.000Z",
        billingPeriodEnd: "2026-08-01T00:00:00.000Z",
      },
    ];

    const exitCode = await runCli(
      ["--mode", "dry_run", "--provider", "real", "--input", "fixture"],
      {
        BROWSERLESS_TOKEN: token,
        AW_PORTAL_EMAIL: "worker@example.test",
        AW_PORTAL_PASSWORD: "portal-secret",
      },
      memory.io,
      {
        adapterFactory: () => adapters,
        usageReaderFactory: () => ({
          snapshot: async () => snapshots.shift()!,
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(memory.stderr()).toContain('"event":"browserless_usage"');
    expect(memory.stderr()).toContain('"unitsConsumed":13');
    expect(memory.stderr()).toContain('"scope":"account_batch_delta"');
    expect(memory.stderr()).not.toContain(token);
    expect(memory.stderr()).not.toContain("portal-secret");
  });
});
