import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReaderLlmProviderError,
  type StructuredPdfClient,
} from "../src/llm/document-reader.js";
import type { ReaderConfig } from "../src/reader/config.js";
import { ReaderDownloadError } from "../src/reader/download.js";
import {
  NukemaSourceExpiredError,
  NukemaSourceUnavailableError,
} from "../src/reader/nukema.js";
import {
  runReaderTick,
  type ReaderDocumentSource,
} from "../src/reader/pipeline.js";
import type { ReaderStore } from "../src/reader/supabase.js";
import type { ClaimedDocument } from "../src/reader/types.js";

const tempDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bsa-reader-pipeline-"));
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

async function pdfBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  return new Uint8Array(await pdf.save());
}

function config(mode: ReaderConfig["mode"], overrides: Partial<ReaderConfig> = {}): ReaderConfig {
  return {
    mode,
    batch: 2,
    model: "google/gemini-3.5-flash",
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role",
    openRouterApiKey: "openrouter",
    nukemaUsername: "reader",
    nukemaPassword: "password",
    maxBytes: 300 * 1024 * 1024,
    maxModelBytes: 20 * 1024 * 1024,
    heartbeatMs: 5,
    pollMs: 5,
    ...overrides,
  };
}

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

function fakeStore(claims: ClaimedDocument[]): ReaderStore & {
  attempts: number;
} {
  let index = 0;
  const store = {
    attempts: 0,
    claimNext: vi.fn(async () => {
      const next = claims[index++] ?? null;
      if (next) store.attempts += 1;
      return next;
    }),
    assertClaim: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    uploadText: vi.fn(async () => undefined),
    uploadObject: vi.fn(async () => undefined),
    upsertZipChild: vi.fn(async (input) => ({
      document_id: `child-${input.fileName}`,
      tender_id: "tender-1",
      parent_document_id: "document-1",
      file_name: input.fileName,
      url: `company-1/tender-1/${input.fileName}`,
    })),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    defer: vi.fn(async () => undefined),
    release: vi.fn(async () => {
      store.attempts -= 1;
      return undefined;
    }),
    recordSpend: vi.fn(async () => undefined),
  } satisfies ReaderStore & { attempts: number };
  return store;
}

function llm(): StructuredPdfClient {
  return {
    generate: vi.fn(async () => ({
      object: { texte: "Règlement lu", pages_lues: 1 },
      costUsd: 0.02,
    })),
  };
}

function invalidLlm(): StructuredPdfClient {
  return {
    generate: vi.fn(async () => ({
      object: { texte: 42, pages_lues: "invalid" },
      costUsd: 0.003,
    })),
  };
}

function source(path: string, delayMs = 0): ReaderDocumentSource {
  return {
    async download() {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { path, bytes: 100, contentType: "application/octet-stream" };
    },
  };
}

function rejectingSource(error: Error): ReaderDocumentSource {
  return {
    async download() {
      throw error;
    },
  };
}

describe("runReaderTick", () => {
  it("does nothing in off mode", async () => {
    const store = fakeStore([claim()]);
    const result = await runReaderTick(config("off"), {
      store,
      source: source("unused"),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(result).toMatchObject({ mode: "off", claimed: 0, processed: 0 });
    expect(store.claimNext).not.toHaveBeenCalled();
  });

  it("completes a PDF and writes one document-level ledger entry in apply", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "RC.pdf");
    await writeFile(path, await pdfBytes());
    const store = fakeStore([claim()]);

    const result = await runReaderTick(config("apply"), {
      store,
      source: source(path),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(result).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
    expect(store.uploadText).toHaveBeenCalledWith(
      "company-1/tender-1/dce-text/document-1.txt",
      "Règlement lu",
    );
    expect(store.recordSpend).toHaveBeenCalledWith({
      tenderId: "tender-1",
      model: "google/gemini-3.5-flash",
      costUsd: 0.02,
      metadata: {
        queue_id: "queue-1",
        document_id: "document-1",
        file_name: "RC.pdf",
        role: "rc",
      },
    });
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        queueId: "queue-1",
        extractionStatus: "extracted_ocr",
        costUsd: 0.02,
      }),
    );
  });

  it("keeps dry_run to control writes and restores the attempt budget", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "RC.pdf");
    await writeFile(path, await pdfBytes());
    const store = fakeStore([claim()]);

    const result = await runReaderTick(config("dry_run"), {
      store,
      source: source(path),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(result).toMatchObject({ claimed: 1, processed: 1, released: 1 });
    expect(store.attempts).toBe(0);
    expect(store.release).toHaveBeenCalledWith(
      "queue-1",
      "reader:test",
      "DRY_RUN_RELEASE",
      expect.any(Array),
    );
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
    expect(store.defer).not.toHaveBeenCalled();
    expect(store.uploadText).not.toHaveBeenCalled();
    expect(store.uploadObject).not.toHaveBeenCalled();
    expect(store.upsertZipChild).not.toHaveBeenCalled();
    expect(store.recordSpend).not.toHaveBeenCalled();
  });

  it("does not process the same released row twice in one dry_run tick", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "RC.pdf");
    await writeFile(path, await pdfBytes());
    const repeatedClaim = claim();
    const store = fakeStore([repeatedClaim, repeatedClaim]);
    const llmClient = llm();

    const result = await runReaderTick(config("dry_run"), {
      store,
      source: source(path),
      llmClient,
      workerId: "reader:test",
    });

    expect(result).toMatchObject({ claimed: 2, processed: 1, released: 1 });
    expect(llmClient.generate).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledTimes(2);
    expect(store.attempts).toBe(0);
  });

  it("materializes a ZIP PDF and spreadsheet before completing its parent", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "DCE.zip");
    await writeFile(
      path,
      zipSync({
        "documents/RC.pdf": await pdfBytes(),
        "prix/BPU.csv": strToU8("designation;prix\nprestation;10"),
      }),
    );
    const store = fakeStore([
      claim({ file_name: "DCE.zip", url: "company-1/tender-1/DCE.zip", analysis_role: null }),
    ]);

    const result = await runReaderTick(config("apply"), {
      store,
      source: source(path),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(store.upsertZipChild).toHaveBeenCalledTimes(2);
    expect(store.uploadObject).toHaveBeenCalledTimes(2);
    expect(store.uploadText).toHaveBeenCalledTimes(2);
    expect(store.recordSpend).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({ extractionStatus: "extracted", costUsd: 0.02 }),
    );
  });

  it("records a billed invalid PDF once before failing it cleanly", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "RC.pdf");
    await writeFile(path, await pdfBytes());
    const store = fakeStore([claim()]);

    const result = await runReaderTick(config("apply", { batch: 1 }), {
      store,
      source: source(path),
      llmClient: invalidLlm(),
      workerId: "reader:test",
    });

    expect(result.results[0]).toMatchObject({
      status: "failed",
      issue: "READER_LLM_INVALID_OUTPUT",
      costUsd: 0.006,
    });
    expect(store.recordSpend).toHaveBeenCalledTimes(1);
    expect(store.fail).toHaveBeenCalledTimes(1);
  });

  it("releases a provider failure after SDK retries without consuming an attempt", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "RC.pdf");
    await writeFile(path, await pdfBytes());
    const store = fakeStore([claim()]);
    const llmClient: StructuredPdfClient = {
      generate: vi.fn(async () => {
        throw new ReaderLlmProviderError(0.004);
      }),
    };

    const result = await runReaderTick(config("apply", { batch: 1 }), {
      store,
      source: source(path),
      llmClient,
      workerId: "reader:test",
    });

    expect(result.results[0]).toMatchObject({
      status: "transient_deferred",
      issue: "READER_LLM_PROVIDER_FAILED",
      costUsd: 0.004,
    });
    expect(store.recordSpend).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(store.fail).not.toHaveBeenCalled();
    expect(store.attempts).toBe(0);
  });

  it("records a billed invalid PDF ZIP child only once", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "DCE.zip");
    await writeFile(path, zipSync({ "documents/RC.pdf": await pdfBytes() }));
    const store = fakeStore([claim({ file_name: "DCE.zip", analysis_role: null })]);

    const result = await runReaderTick(config("apply", { batch: 1 }), {
      store,
      source: source(path),
      llmClient: invalidLlm(),
      workerId: "reader:test",
    });

    expect(result.results[0]).toMatchObject({ costUsd: 0.006 });
    expect(store.recordSpend).toHaveBeenCalledTimes(1);
    expect(store.recordSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        costUsd: 0.006,
        metadata: expect.objectContaining({ entry_path: "documents/RC.pdf" }),
      }),
    );
  });

  it("isolates a failing ZIP sheet, completes the readable rest and marks the failure", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "DCE.zip");
    await writeFile(
      path,
      zipSync({
        "pieces/RC.pdf": await pdfBytes(),
        "prix/BPU.csv": strToU8("designation;prix\nprestation;10"),
        "pieces/PGC.pdf": await pdfBytes(),
        "scans/illisible.pdf": strToU8("corrompu"),
      }),
    );
    const store = fakeStore([
      claim({ file_name: "DCE.zip", url: "company-1/tender-1/DCE.zip", analysis_role: null }),
    ]);
    const generate = vi.fn(async ({ fileName }: { fileName: string }) =>
      fileName.includes("PGC")
        ? { object: { texte: 42 }, costUsd: 0.003 }
        : { object: { texte: "Règlement lu", pages_lues: 1 }, costUsd: 0.02 },
    );

    const result = await runReaderTick(config("apply", { batch: 1 }), {
      store,
      source: source(path),
      llmClient: { generate },
      workerId: "reader:test",
    });

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    expect(result.results[0]).toMatchObject({
      status: "extracted",
      costUsd: expect.closeTo(0.026, 9) as number,
    });
    expect(store.fail).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        extractionStatus: "extracted",
        costUsd: expect.closeTo(0.026, 9) as number,
        notes: expect.arrayContaining([
          expect.objectContaining({
            entry: "pieces/PGC.pdf",
            kind: "pdf",
            status: "failed",
            reason: "READER_LLM_INVALID_OUTPUT",
            costUsd: 0.006,
          }),
          expect.objectContaining({
            entry: "scans/illisible.pdf",
            status: "unsupported_format",
          }),
        ]),
      }),
    );
    expect(
      vi.mocked(store.upsertZipChild).mock.calls.map(([input]) => input.entryPath),
    ).toEqual(["pieces/RC.pdf", "prix/BPU.csv", "scans/illisible.pdf"]);
    expect(store.recordSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        costUsd: 0.006,
        metadata: expect.objectContaining({ entry_path: "pieces/PGC.pdf" }),
      }),
    );
  });

  it("fails a ZIP globally only when no sheet at all is readable", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "DCE.zip");
    await writeFile(
      path,
      zipSync({
        "pieces/CCAP.pdf": await pdfBytes(),
        "pieces/PGC.pdf": await pdfBytes(),
      }),
    );
    const store = fakeStore([claim({ file_name: "DCE.zip", analysis_role: null })]);

    const result = await runReaderTick(config("apply", { batch: 1 }), {
      store,
      source: source(path),
      llmClient: invalidLlm(),
      workerId: "reader:test",
    });

    expect(result).toMatchObject({ processed: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({
      status: "failed",
      issue: "READER_ZIP_NO_READABLE_LEAF",
      costUsd: expect.closeTo(0.012, 9) as number,
    });
    expect(store.fail).toHaveBeenCalledWith(
      "queue-1",
      "reader:test",
      "READER_ZIP_NO_READABLE_LEAF",
      expect.arrayContaining([
        expect.objectContaining({
          entry: "pieces/CCAP.pdf",
          status: "failed",
          reason: "READER_LLM_INVALID_OUTPUT",
        }),
        expect.objectContaining({
          entry: "pieces/PGC.pdf",
          status: "failed",
          reason: "READER_LLM_INVALID_OUTPUT",
        }),
      ]),
    );
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.recordSpend).toHaveBeenCalledTimes(2);
  });

  it("fails a corrupt ZIP cleanly without stopping the tick", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "aussillon.zip");
    await writeFile(path, "Erreur 94");
    const store = fakeStore([claim({ file_name: "aussillon.zip" })]);

    const result = await runReaderTick(config("apply"), {
      store,
      source: source(path),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(result).toMatchObject({ processed: 0, failed: 1 });
    expect(store.fail).toHaveBeenCalledWith(
      "queue-1",
      "reader:test",
      "ZIP_CORRUPT",
      expect.any(Array),
    );
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("defers an expired Nukema source once, then completes it as source_expired", async () => {
    const firstStore = fakeStore([claim({ attempts: 1, source_reference: "source-1" })]);
    const secondStore = fakeStore([claim({ attempts: 2, source_reference: "source-1" })]);

    const first = await runReaderTick(config("apply", { batch: 1 }), {
      store: firstStore,
      source: rejectingSource(new NukemaSourceExpiredError(404)),
      llmClient: llm(),
      workerId: "reader:test",
    });
    const second = await runReaderTick(config("apply", { batch: 1 }), {
      store: secondStore,
      source: rejectingSource(new NukemaSourceExpiredError(404)),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(first.results[0]?.status).toBe("source_expired_deferred");
    expect(firstStore.defer).toHaveBeenCalledWith(
      "queue-1",
      "reader:test",
      "NUKEMA_SOURCE_EXPIRED",
      expect.any(Array),
      86_400,
    );
    expect(second.results[0]?.status).toBe("source_expired");
    expect(secondStore.complete).toHaveBeenCalledWith(
      expect.objectContaining({ extractionStatus: "source_expired" }),
    );
  });

  it("completes a Nukema text error payload as source_expired", async () => {
    const store = fakeStore([claim({ source_reference: "source-1" })]);

    const result = await runReaderTick(config("apply", { batch: 1 }), {
      store,
      source: rejectingSource(new NukemaSourceUnavailableError("text/plain")),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(result.results[0]?.status).toBe("source_expired");
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({ extractionStatus: "source_expired" }),
    );
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("marks a document over the configured cap without retrying it", async () => {
    const store = fakeStore([claim()]);

    const result = await runReaderTick(config("apply", { batch: 1 }), {
      store,
      source: rejectingSource(new ReaderDownloadError("DOCUMENT_TOO_LARGE")),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(result.results[0]?.status).toBe("too_large");
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({ extractionStatus: "too_large" }),
    );
  });

  it("heartbeats periodically while a claimed download is still running", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "unknown.bin");
    await writeFile(path, "fixture");
    const store = fakeStore([claim({ file_name: "unknown.bin" })]);

    await runReaderTick(config("apply", { batch: 1, heartbeatMs: 5 }), {
      store,
      source: source(path, 35),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(vi.mocked(store.heartbeat).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("never claims more than READER_BATCH documents in one tick", async () => {
    const directory = await tempDirectory();
    const path = join(directory, "unknown.bin");
    await writeFile(path, "fixture");
    const store = fakeStore([
      claim({ queue_id: "q1", document_id: "d1", file_name: "unknown.bin" }),
      claim({ queue_id: "q2", document_id: "d2", file_name: "unknown.bin" }),
      claim({ queue_id: "q3", document_id: "d3", file_name: "unknown.bin" }),
    ]);

    const result = await runReaderTick(config("apply", { batch: 2 }), {
      store,
      source: source(path),
      llmClient: llm(),
      workerId: "reader:test",
    });

    expect(result.claimed).toBe(2);
    expect(store.claimNext).toHaveBeenCalledTimes(2);
  });
});
