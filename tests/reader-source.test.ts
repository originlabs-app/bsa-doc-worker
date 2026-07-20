import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadNukemaSourceToFile,
  NukemaSourceExpiredError,
  NukemaSourceUnavailableError,
} from "../src/reader/nukema.js";
import { createReaderDocumentSource } from "../src/reader/source.js";
import type { ClaimedDocument } from "../src/reader/types.js";

const tempDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bsa-reader-source-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function claim(overrides: Partial<ClaimedDocument> = {}): ClaimedDocument {
  return {
    queue_id: "queue-1",
    attempts: 1,
    claimed_at: new Date(0).toISOString(),
    document_id: "document-1",
    tender_id: "tender-1",
    company_id: "company-1",
    file_name: "RC.pdf",
    url: "company-1/tender-1/RC.pdf",
    source_url: null,
    source_reference: null,
    analysis_role: "rc",
    extraction_status: "oversized_document",
    ...overrides,
  };
}

describe("Nukema streaming source", () => {
  it("authenticates, obtains the download token and streams the attachment", async () => {
    const directory = await tempDirectory();
    const targetPath = join(directory, "RC.pdf");
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify("download-token")))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), {
          headers: { "content-type": "application/pdf" },
        }),
      );
    const progress = vi.fn();

    const result = await downloadNukemaSourceToFile({
      username: "reader",
      password: "secret",
      sourceReference: "attachment/id",
      fileName: "RC.pdf",
      targetPath,
      maxBytes: 1024,
      fetchFn,
      signal: new AbortController().signal,
      onProgress: progress,
    });

    expect(result).toEqual({ bytes: 5, contentType: "application/pdf" });
    expect(await readFile(targetPath)).toEqual(
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("id=attachment%2Fid&token=download-token"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(progress).toHaveBeenCalledWith(5);
  });

  it("derives the source reference from a Nukema URL and types expired links", async () => {
    const directory = await tempDirectory();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" })))
      .mockResolvedValueOnce(new Response("token"))
      .mockResolvedValueOnce(new Response(null, { status: 410 }));

    await expect(
      downloadNukemaSourceToFile({
        username: "reader",
        password: "secret",
        sourceUrl: "https://example.test/download?id=source-42",
        fileName: "RC.pdf",
        targetPath: join(directory, "RC.pdf"),
        maxBytes: 1024,
        fetchFn,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NukemaSourceExpiredError);
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("id=source-42"),
      expect.any(Object),
    );
  });

  it("rejects a textual error payload masquerading as a binary document", async () => {
    const directory = await tempDirectory();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" })))
      .mockResolvedValueOnce(new Response("token"))
      .mockResolvedValueOnce(
        new Response("attachment unavailable", {
          headers: { "content-type": "text/plain" },
        }),
      );

    await expect(
      downloadNukemaSourceToFile({
        username: "reader",
        password: "secret",
        sourceReference: "source-42",
        fileName: "DCE.zip",
        targetPath: join(directory, "DCE.zip"),
        maxBytes: 1024,
        fetchFn,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NukemaSourceUnavailableError);
  });
});

describe("createReaderDocumentSource", () => {
  it("streams Supabase storage objects with service-role headers", async () => {
    const directory = await tempDirectory();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("fixture", { headers: { "content-type": "text/plain" } }),
    );
    const source = createReaderDocumentSource({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "service-role",
      nukemaUsername: "reader",
      nukemaPassword: "secret",
      maxBytes: 1024,
      fetchFn,
    });

    const result = await source.download(
      claim({ file_name: "unknown.txt" }),
      directory,
      vi.fn(),
      new AbortController().signal,
    );

    expect(await readFile(result.path, "utf8")).toBe("fixture");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.supabase.co/storage/v1/object/appel-offre-documents/company-1/tender-1/RC.pdf",
      expect.objectContaining({
        headers: {
          apikey: "service-role",
          Authorization: "Bearer service-role",
        },
      }),
    );
  });
});
