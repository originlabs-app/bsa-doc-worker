import { createHash } from "node:crypto";
import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { streamAttachment } from "../src/download.js";
import type {
  DocumentIngestionSink,
  EphemeralAttachment,
  QuarantineWrite,
} from "../src/ports.js";

function attachment(
  overrides: Partial<EphemeralAttachment> = {},
): EphemeralAttachment {
  return {
    stableId: "attachment-1",
    fileName: "document.pdf",
    kind: "pdf",
    expectedSize: null,
    downloadUrl:
      "https://downloads.awsolutions.fr/dce/attachment/document?signature=fixture",
    requestHeaders: {
      Cookie: "CFID=must-not-cross-host; CFTOKEN=must-not-cross-host",
      "User-Agent": "fixture-agent",
    },
    ...overrides,
  };
}

function fakeSink() {
  const chunks: Buffer[] = [];
  const commit = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const validate = vi.fn(async () => undefined);
  const write: QuarantineWrite = {
    writable: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
    validate,
    commit,
    abort,
  };
  const sink: DocumentIngestionSink = { open: vi.fn(async () => write) };
  return { sink, chunks, commit, abort, validate };
}

describe("streamAttachment", () => {
  it("streams a valid PDF through quarantine and records its SHA-256", async () => {
    const bytes = Buffer.from("%PDF-1.7\nfixture");
    const fetcher = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      },
    );
    const target = fakeSink();

    const receipt = await streamAttachment(attachment(), target.sink, {
      fetcher,
    });

    expect(Buffer.concat(target.chunks)).toEqual(bytes);
    expect(receipt.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(target.validate).toHaveBeenCalledOnce();
    expect(target.commit).toHaveBeenCalledWith(receipt);
    expect(target.abort).not.toHaveBeenCalled();
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Cookie).toBeUndefined();
  });

  it("rejects HTML masquerading as a document and aborts quarantine", async () => {
    const fetcher = vi.fn(async () =>
      new Response("<!doctype html><title>Login</title>", {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
    const target = fakeSink();

    await expect(
      streamAttachment(attachment(), target.sink, { fetcher }),
    ).rejects.toThrow("DOWNLOAD_INCOMPLETE");

    expect(target.abort).toHaveBeenCalledOnce();
    expect(target.commit).not.toHaveBeenCalled();
  });

  it("rejects a declared response above the configured byte cap before opening storage", async () => {
    const fetcher = vi.fn(async () =>
      new Response("%PDF-too-large", {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": "1000",
        },
      }),
    );
    const target = fakeSink();

    await expect(
      streamAttachment(attachment(), target.sink, {
        fetcher,
        maxBytes: 100,
      }),
    ).rejects.toThrow("DOWNLOAD_INCOMPLETE");

    expect(target.sink.open).not.toHaveBeenCalled();
  });

  it("rejects redirects outside the attachment allowlist", async () => {
    const fetcher = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.test/document.pdf" },
      }),
    );
    const target = fakeSink();

    await expect(
      streamAttachment(attachment(), target.sink, { fetcher }),
    ).rejects.toThrow("DOWNLOAD_INCOMPLETE");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(target.sink.open).not.toHaveBeenCalled();
  });

  it.each([
    {
      sourcePlatform: "place" as const,
      downloadUrl:
        "https://telechargement.marches-publics.gouv.fr/dce/download/package-3036454?token=fixture",
    },
    {
      sourcePlatform: "maximilien" as const,
      downloadUrl:
        "https://fichiers.marches.maximilien.fr/dce/attachment/package-7788?token=fixture",
    },
    {
      sourcePlatform: "place" as const,
      downloadUrl:
        "https://www.marches-publics.gouv.fr/index.php?page=Entreprise.EntrepriseDownloadReglement&id=3040234&orgAcronyme=fixture",
    },
    {
      sourcePlatform: "maximilien" as const,
      downloadUrl:
        "https://marches.maximilien.fr/index.php?page=Entreprise.EntrepriseDemandeTelechargementDce&id=942952&orgAcronyme=fixture",
    },
  ])(
    "streams an allowlisted $sourcePlatform attachment over HTTP",
    async ({ sourcePlatform, downloadUrl }) => {
      const bytes = Buffer.from("%PDF-1.7\nportal fixture");
      const fetcher = vi.fn(async () =>
        new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      );
      const target = fakeSink();

      await expect(
        streamAttachment(
          attachment({ sourcePlatform, downloadUrl }),
          target.sink,
          { fetcher },
        ),
      ).resolves.toMatchObject({ bytes: bytes.byteLength });

      expect(target.commit).toHaveBeenCalledOnce();
    },
  );

  it("rejects an Atexo query-string action that is not a download action", async () => {
    const fetcher = vi.fn();
    const target = fakeSink();

    await expect(
      streamAttachment(
        attachment({
          sourcePlatform: "maximilien",
          downloadUrl:
            "https://marches.maximilien.fr/index.php?page=Entreprise.EntrepriseSignatureDocument&id=942952",
        }),
        target.sink,
        { fetcher },
      ),
    ).rejects.toThrow("DOWNLOAD_INCOMPLETE");

    expect(fetcher).not.toHaveBeenCalled();
    expect(target.sink.open).not.toHaveBeenCalled();
  });

  it("rejects a URL whose host does not match its source platform", async () => {
    const fetcher = vi.fn();
    const target = fakeSink();

    await expect(
      streamAttachment(
        attachment({
          sourcePlatform: "place",
          downloadUrl:
            "https://fichiers.marches.maximilien.fr/dce/attachment/package-7788",
        }),
        target.sink,
        { fetcher },
      ),
    ).rejects.toThrow("DOWNLOAD_INCOMPLETE");

    expect(fetcher).not.toHaveBeenCalled();
    expect(target.sink.open).not.toHaveBeenCalled();
  });
});
