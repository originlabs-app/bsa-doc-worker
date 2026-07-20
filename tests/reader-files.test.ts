import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StructuredPdfClient } from "../src/llm/document-reader.js";
import { streamResponseToFile } from "../src/reader/download.js";
import {
  extractZipLeaves,
  type ReaderArchiveError,
} from "../src/reader/archive.js";
import { readLocalDocument } from "../src/reader/readers.js";

const tempDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bsa-reader-test-"));
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

async function pdfFixture(text?: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  if (text) {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: 30, y: 340, size: 12, font });
  }
  return new Uint8Array(await pdf.save());
}

function llmFixture(): StructuredPdfClient {
  return {
    generate: vi.fn(async ({ fileName }) => ({
      object: {
        texte: fileName.includes("scan") ? "OCR du scan" : "Texte du PDF",
        pages_lues: 1,
      },
      costUsd: 0.005,
    })),
  };
}

describe("streamResponseToFile", () => {
  it("writes streamed chunks without asking the response for one array buffer", async () => {
    const directory = await tempDirectory();
    const target = join(directory, "document.bin");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(strToU8("premier "));
          controller.enqueue(strToU8("second"));
          controller.close();
        },
      }),
      { headers: { "content-length": "14" } },
    );
    const progress: number[] = [];

    await expect(
      streamResponseToFile(response, target, 100, (bytes) => {
        progress.push(bytes);
      }),
    ).resolves.toBe(14);
    await expect(readFile(target, "utf8")).resolves.toBe("premier second");
    expect(progress).toEqual([8, 14]);
  });

  it("rejects a stream as soon as it crosses the configured cap", async () => {
    const directory = await tempDirectory();
    const response = new Response(strToU8("trop grand"));
    await expect(
      streamResponseToFile(response, join(directory, "large.bin"), 4),
    ).rejects.toThrow("DOCUMENT_TOO_LARGE");
  });
});

describe("local document fixtures", () => {
  it("reads both a text PDF and a scanned PDF through the typed LLM contract", async () => {
    const directory = await tempDirectory();
    const textPath = join(directory, "RC.pdf");
    const scanPath = join(directory, "scan.pdf");
    await writeFile(textPath, await pdfFixture("Règlement de consultation"));
    await writeFile(scanPath, await pdfFixture());
    const llmClient = llmFixture();

    const textResult = await readLocalDocument(
      { path: textPath, fileName: "RC.pdf" },
      { llmClient, knownRole: "rc", maxModelBytes: 20 * 1024 * 1024 },
    );
    const scanResult = await readLocalDocument(
      { path: scanPath, fileName: "scan.pdf" },
      { llmClient, knownRole: null, maxModelBytes: 20 * 1024 * 1024 },
    );

    expect(textResult).toMatchObject({
      kind: "pdf",
      status: "extracted_ocr",
      text: "Texte du PDF",
      modelCostUsd: 0.005,
    });
    expect(scanResult).toMatchObject({
      kind: "pdf",
      status: "extracted_ocr",
      text: "OCR du scan",
      modelCostUsd: 0.005,
    });
  });

  it("extracts a multi-file ZIP lazily and keeps stable entry paths", async () => {
    const directory = await tempDirectory();
    const zipPath = join(directory, "dce.zip");
    await writeFile(
      zipPath,
      zipSync({
        "pieces/RC.pdf": await pdfFixture("RC"),
        "prix/BPU.csv": strToU8("designation;prix\nprestation;12"),
        "plans/plan.dwg": strToU8("ignored"),
      }),
    );

    const result = await extractZipLeaves(zipPath, directory);

    expect(result.leaves.map((leaf) => leaf.entryPath)).toEqual([
      "pieces/RC.pdf",
      "prix/BPU.csv",
    ]);
    expect(result.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entry: "plans/plan.dwg", reason: "not_selected" }),
      ]),
    );
    await expect(readFile(result.leaves[1]!.path, "utf8")).resolves.toContain(
      "prestation;12",
    );
  });

  it("turns a corrupt ZIP into a short typed failure", async () => {
    const directory = await tempDirectory();
    const zipPath = join(directory, "aussillon.zip");
    await writeFile(zipPath, "Erreur 94 — archive illisible");

    const promise = extractZipLeaves(zipPath, directory);
    await expect(promise).rejects.toMatchObject({
      name: "ReaderArchiveError",
      code: "ZIP_CORRUPT",
    } satisfies Partial<ReaderArchiveError>);
  });
});
