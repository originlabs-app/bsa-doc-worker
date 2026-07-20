import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";

import yauzl, { type Entry, type ZipFile } from "yauzl";

import type { ExtractionNote } from "./types.js";

const DEFAULT_MAX_ENTRIES = 80;
const DEFAULT_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_INFLATED_BYTES = 120 * 1024 * 1024;

export interface ArchiveLeaf {
  entryPath: string;
  fileName: string;
  path: string;
  bytes: number;
  depth: number;
}

export interface ArchiveExtractionResult {
  leaves: ArchiveLeaf[];
  notes: ExtractionNote[];
}

export class ReaderArchiveError extends Error {
  readonly code = "ZIP_CORRUPT";

  constructor(options?: ErrorOptions) {
    super("ZIP_CORRUPT", options);
    this.name = "ReaderArchiveError";
  }
}

function selectedEntry(fileName: string): boolean {
  const normalized = fileName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  if (/(^|\/)(plan|plans|graphique|graphiques|dwg)([^/]*$)/.test(normalized)) {
    return false;
  }
  return /\.(pdf|docx|doc|csv|xls|xlsx|ods|zip)$/.test(normalized);
}

function isZip(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".zip");
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      {
        lazyEntries: true,
        autoClose: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("zip_open_failed"));
        else resolve(zip);
      },
    );
  });
}

function openEntryStream(zip: ZipFile, entry: Entry) {
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("zip_stream_failed"));
      else resolve(stream);
    });
  });
}

function tempEntryPath(directory: string, entryPath: string): string {
  const digest = createHash("sha256").update(entryPath).digest("hex");
  const extension = basename(entryPath).match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
  return join(directory, `zip-entry-${digest}${extension}`);
}

async function visitZip(
  zipPath: string,
  tempDirectory: string,
  depth: number,
  prefix: string,
  limits: { maxEntries: number; maxEntryBytes: number; maxInflatedBytes: number },
  budget: { seenEntries: number; inflatedBytes: number },
  output: ArchiveExtractionResult,
): Promise<void> {
  const zip = await openZip(zipPath);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      void (async () => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        const entryPath = prefix ? `${prefix}/${entry.fileName}` : entry.fileName;
        budget.seenEntries += 1;
        if (budget.seenEntries > limits.maxEntries) {
          output.notes.push({
            entry: entryPath,
            kind: "unknown",
            status: "skipped",
            bytes: entry.uncompressedSize,
            depth,
            reason: "entry_limit_exceeded",
          });
          zip.readEntry();
          return;
        }
        if (!selectedEntry(entry.fileName)) {
          output.notes.push({
            entry: entryPath,
            kind: "unknown",
            status: "skipped",
            bytes: entry.uncompressedSize,
            depth,
            reason: "not_selected",
          });
          zip.readEntry();
          return;
        }
        if (isZip(entry.fileName) && depth >= 1) {
          output.notes.push({
            entry: entryPath,
            kind: "zip",
            status: "skipped",
            bytes: entry.uncompressedSize,
            depth,
            reason: "max_depth",
          });
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > limits.maxEntryBytes) {
          output.notes.push({
            entry: entryPath,
            kind: "unknown",
            status: "skipped",
            bytes: entry.uncompressedSize,
            depth,
            reason: "inflated_entry_too_large",
          });
          zip.readEntry();
          return;
        }
        if (budget.inflatedBytes + entry.uncompressedSize > limits.maxInflatedBytes) {
          output.notes.push({
            entry: entryPath,
            kind: "unknown",
            status: "skipped",
            bytes: entry.uncompressedSize,
            depth,
            reason: "inflated_budget_exceeded",
          });
          zip.readEntry();
          return;
        }

        budget.inflatedBytes += entry.uncompressedSize;
        const targetPath = tempEntryPath(tempDirectory, entryPath);
        const stream = await openEntryStream(zip, entry);
        await pipeline(stream, createWriteStream(targetPath, { flags: "wx", mode: 0o600 }));
        if (isZip(entry.fileName)) {
          output.notes.push({
            entry: entryPath,
            kind: "zip",
            status: "opened",
            bytes: entry.uncompressedSize,
            depth,
          });
          await visitZip(
            targetPath,
            tempDirectory,
            depth + 1,
            entryPath,
            limits,
            budget,
            output,
          );
          await rm(targetPath, { force: true });
        } else {
          output.leaves.push({
            entryPath,
            fileName: basename(entry.fileName),
            path: targetPath,
            bytes: entry.uncompressedSize,
            depth,
          });
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

export async function extractZipLeaves(
  zipPath: string,
  tempDirectory: string,
  options: {
    maxEntries?: number;
    maxEntryBytes?: number;
    maxInflatedBytes?: number;
  } = {},
): Promise<ArchiveExtractionResult> {
  const output: ArchiveExtractionResult = { leaves: [], notes: [] };
  try {
    await visitZip(
      zipPath,
      tempDirectory,
      0,
      "",
      {
        maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
        maxEntryBytes: options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
        maxInflatedBytes:
          options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES,
      },
      { seenEntries: 0, inflatedBytes: 0 },
      output,
    );
    return output;
  } catch (error) {
    throw new ReaderArchiveError({ cause: error });
  }
}
