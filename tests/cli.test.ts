import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/cli.js";

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
});
