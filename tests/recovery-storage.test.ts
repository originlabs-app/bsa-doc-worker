import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSupabaseRecoveryStorage } from "../src/recovery/storage.js";

describe("createSupabaseRecoveryStorage", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("streams a new object with upsert disabled and removes only explicit paths", async () => {
    directory = await mkdtemp(join(tmpdir(), "recovery-storage-test-"));
    const localPath = join(directory, "DCE.pdf");
    await writeFile(localPath, "%PDF-1.7\nfixture");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const storage = createSupabaseRecoveryStorage({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "fixture-secret",
      fetcher,
    });

    await expect(
      storage.upload({
        objectPath: "company/tender/DCE électricité.pdf",
        localPath,
        contentType: "application/pdf",
        bytes: 16,
      }),
    ).resolves.toEqual({ created: true });
    const upload = fetcher.mock.calls[0]!;
    expect(upload[0].toString()).toBe(
      "https://project.supabase.co/storage/v1/object/appel-offre-documents/company/tender/DCE%20%C3%A9lectricit%C3%A9.pdf",
    );
    expect(upload[1]?.headers).toMatchObject({ "x-upsert": "false" });

    await storage.remove(["company/tender/DCE électricité.pdf"]);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ prefixes: ["company/tender/DCE électricité.pdf"] }),
    });
  });

  it("treats an existing object as reusable without overwriting it", async () => {
    directory = await mkdtemp(join(tmpdir(), "recovery-storage-test-"));
    const localPath = join(directory, "DCE.pdf");
    await writeFile(localPath, "%PDF-1.7\nfixture");
    const storage = createSupabaseRecoveryStorage({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "fixture-secret",
      fetcher: vi.fn(async () => new Response("exists", { status: 409 })),
    });

    await expect(
      storage.upload({
        objectPath: "company/tender/DCE.pdf",
        localPath,
        contentType: "application/pdf",
        bytes: 16,
      }),
    ).resolves.toEqual({ created: false });
  });
});
