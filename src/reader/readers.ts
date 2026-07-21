import { readFile, stat } from "node:fs/promises";

import { unzipSync } from "fflate";
import WordExtractor from "word-extractor";
import * as XLSX from "xlsx";

import {
  ReaderLlmInvalidOutputError,
  ReaderLlmProviderError,
  roundedCost,
  type StructuredPdfClient,
} from "../llm/document-reader.js";
import type { DocumentReaderRole } from "../llm/document-schemas.js";
import { classifyAnalysisRole } from "./classification.js";
import {
  compareReaderPayloads,
  generateAuditPayload,
  readPdfWithModelCascade,
  type CascadePdfInput,
} from "./model-cascade.js";
import {
  copyPdfHeadTailPages,
  splitPdfIntoPageChunks,
  type PdfPageChunk,
} from "./pdf-subset.js";
import type {
  AnalysisRole,
  DocumentKind,
  ExtractionNote,
  ExtractionStatus,
  ReaderAuditOutcome,
} from "./types.js";

const PDF_SUBSET = { firstPages: 30, tailPages: 10 };
const PDF_CHUNK_PAGES = 8;
const MAX_DOCX_PART_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_INFLATED_BYTES = 120 * 1024 * 1024;

export interface LocalDocument {
  path: string;
  fileName: string;
}

export interface LocalDocumentReadResult {
  kind: Exclude<DocumentKind, "zip">;
  status: ExtractionStatus;
  text: string;
  /** Coût de la lecture (titulaire + secours), hors audit. */
  modelCostUsd: number;
  pagesRead?: number;
  modelAttempts?: number;
  /** Présents uniquement quand la pièce est passée par le lecteur LLM. */
  fallbackUsed?: boolean;
  zodAttempts?: number;
  primaryCostUsd?: number;
  fallbackCostUsd?: number;
  audit?: ReaderAuditOutcome;
  notes: ExtractionNote[];
}

export interface LocalDocumentReaderOptions {
  llmClient: StructuredPdfClient;
  /** Modèle de secours de la cascade ; absent = cascade désactivée. */
  fallbackLlmClient?: StructuredPdfClient | null;
  /** Pièce tirée au sort pour l'audit lite vs secours (décidé par l'appelant). */
  auditSampled?: boolean;
  knownRole: AnalysisRole | null;
  maxModelBytes: number;
  legacyDocExtractor?: (bytes: Uint8Array, fileName: string) => Promise<string>;
}

function pdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

function zipMagic(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function normalize(fileName: string): string {
  return fileName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function detectDocumentKind(
  fileName: string,
  bytes: Uint8Array,
): DocumentKind {
  const name = normalize(fileName);
  if (pdfMagic(bytes)) return "pdf";
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".doc")) return "doc";
  if (/\.(csv|xls|xlsx|ods)$/.test(name)) return "spreadsheet";
  if (name.endsWith(".zip") || zipMagic(bytes)) return "zip";
  return "unknown";
}

function firstHex(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 4))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function unsupported(
  fileName: string,
  bytes: Uint8Array,
  reason: string,
  kind: "unknown" | "doc" = "unknown",
): LocalDocumentReadResult {
  return {
    kind,
    status: "unsupported_format",
    text: "",
    modelCostUsd: 0,
    notes: [
      {
        entry: fileName,
        kind,
        status: "unsupported_format",
        bytes: bytes.byteLength,
        reason,
        magicHex: firstHex(bytes),
      },
    ],
  };
}

function xmlText(xml: string): string {
  return [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
    .map((paragraph) =>
      [...(paragraph[0] ?? "").matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
        .map((chunk) => chunk[1] ?? "")
        .join("")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

function readDocx(bytes: Uint8Array, fileName: string): LocalDocumentReadResult {
  let inflated = 0;
  try {
    const entries = unzipSync(bytes, {
      filter(entry) {
        const selected =
          entry.name === "[Content_Types].xml" ||
          /^word\/(document|header|footer|footnotes|endnotes)\d*\.xml$/.test(
            entry.name,
          );
        if (!selected) return false;
        if (
          entry.originalSize > MAX_DOCX_PART_BYTES ||
          inflated + entry.originalSize > MAX_DOCX_INFLATED_BYTES
        )
          return false;
        inflated += entry.originalSize;
        return true;
      },
    });
    if (!entries["word/document.xml"]) {
      return unsupported(fileName, bytes, "docx_document_part_missing");
    }
    const decoder = new TextDecoder();
    const text = Object.keys(entries)
      .filter((name) => /^word\/(document|header|footer|footnotes|endnotes)/.test(name))
      .sort((left) => (left === "word/document.xml" ? -1 : 1))
      .map((name) => xmlText(decoder.decode(entries[name])))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    return {
      kind: "docx",
      status: text ? "word_extracted" : "empty_text",
      text,
      modelCostUsd: 0,
      notes: [
        {
          entry: fileName,
          kind: "docx",
          status: text ? "word_extracted" : "empty_text",
          bytes: bytes.byteLength,
        },
      ],
    };
  } catch (error) {
    return unsupported(
      fileName,
      bytes,
      `docx_parse_failed:${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

async function readLegacyDoc(
  bytes: Uint8Array,
  fileName: string,
  extractorOverride?: (bytes: Uint8Array, fileName: string) => Promise<string>,
): Promise<LocalDocumentReadResult> {
  try {
    let text: string;
    if (extractorOverride) {
      text = await extractorOverride(bytes, fileName);
    } else {
      const document = await new WordExtractor().extract(Buffer.from(bytes));
      text = [
        document.getBody(),
        document.getHeaders(),
        document.getFooters(),
        document.getFootnotes(),
        document.getEndnotes(),
      ]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n");
    }
    return {
      kind: "doc",
      status: text.trim() ? "word_extracted" : "empty_text",
      text: text.trim(),
      modelCostUsd: 0,
      notes: [
        {
          entry: fileName,
          kind: "doc",
          status: text.trim() ? "word_extracted" : "empty_text",
          bytes: bytes.byteLength,
        },
      ],
    };
  } catch (error) {
    return unsupported(
      fileName,
      bytes,
      `legacy_doc_parse_failed:${error instanceof Error ? error.name : "unknown"}`,
      "doc",
    );
  }
}

function readSpreadsheet(
  bytes: Uint8Array,
  fileName: string,
): LocalDocumentReadResult {
  let text: string;
  if (fileName.toLowerCase().endsWith(".csv")) {
    text = new TextDecoder().decode(bytes).slice(0, 80_000).trim();
  } else {
    const workbook = XLSX.read(bytes, {
      type: "array",
      dense: true,
      sheetRows: 1_500,
      cellHTML: false,
      cellFormula: false,
      cellStyles: false,
    });
    text = workbook.SheetNames.slice(0, 12)
      .map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) return "";
        const rows = XLSX.utils
          .sheet_to_json<unknown[]>(sheet, {
            header: 1,
            raw: false,
            blankrows: false,
          })
          .slice(0, 400)
          .map((row) => row.map((cell) => String(cell ?? "").trim()).join(" | "))
          .filter(Boolean);
        return rows.length ? `Feuille ${sheetName}\n${rows.join("\n")}` : "";
      })
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 80_000)
      .trim();
  }
  return {
    kind: "spreadsheet",
    status: text ? "extracted" : "empty_text",
    text,
    modelCostUsd: 0,
    notes: [
      {
        entry: fileName,
        kind: "spreadsheet",
        status: text ? "extracted" : "empty_text",
        bytes: bytes.byteLength,
      },
    ],
  };
}

async function auditPiece(
  calls: CascadePdfInput[],
  expected: { text: string; pagesRead: number },
  client: StructuredPdfClient,
): Promise<ReaderAuditOutcome> {
  let costUsd = 0;
  const parts: string[] = [];
  let pagesRead = 0;
  for (const call of calls) {
    const generated = await generateAuditPayload(call, client);
    costUsd = roundedCost(costUsd + generated.costUsd);
    if (!generated.payload) {
      return { status: "audit_failed", agree: false, fieldsDiff: [], costUsd };
    }
    const text = generated.payload.texte.trim();
    if (text) parts.push(text);
    pagesRead += generated.payload.pages_lues;
  }
  const fieldsDiff = compareReaderPayloads(
    { texte: expected.text, pages_lues: expected.pagesRead },
    { texte: parts.join("\n\n").trim(), pages_lues: pagesRead },
  );
  return {
    status: "compared",
    agree: fieldsDiff.length === 0,
    fieldsDiff,
    costUsd,
  };
}

function auditNote(fileName: string, audit: ReaderAuditOutcome): ExtractionNote {
  return {
    entry: fileName,
    kind: "pdf",
    status: "audit_sample",
    reason:
      audit.status === "audit_failed"
        ? "audit_failed"
        : audit.agree
          ? "agree"
          : `disagree:${audit.fieldsDiff.join(",")}`,
    costUsd: audit.costUsd,
  };
}

async function maybeAuditPiece(
  calls: CascadePdfInput[],
  read: { text: string; pagesRead: number; fallbackUsed: boolean },
  options: LocalDocumentReaderOptions,
): Promise<ReaderAuditOutcome | undefined> {
  if (
    !options.auditSampled ||
    !options.fallbackLlmClient ||
    read.fallbackUsed ||
    !read.text
  ) {
    return undefined;
  }
  return auditPiece(
    calls,
    { text: read.text, pagesRead: read.pagesRead },
    options.fallbackLlmClient,
  );
}

async function readPdfInChunks(input: {
  document: LocalDocument;
  sourceBytes: Uint8Array;
  sentBytes: Uint8Array;
  chunks: PdfPageChunk[];
  role: DocumentReaderRole;
  options: LocalDocumentReaderOptions;
  pageCount?: number;
  pages?: string;
}): Promise<LocalDocumentReadResult> {
  const parts: string[] = [];
  const chunkNotes: ExtractionNote[] = [];
  const calls: CascadePdfInput[] = [];
  let totalCost = 0;
  let primaryCost = 0;
  let fallbackCost = 0;
  let pagesRead = 0;
  let attempts = 1;
  let zodAttempts = 0;
  let fallbackUsed = false;
  for (const chunk of input.chunks) {
    const call: CascadePdfInput = {
      bytes: chunk.bytes,
      fileName: input.document.fileName,
      role: input.role,
    };
    calls.push(call);
    let slice;
    try {
      slice = await readPdfWithModelCascade(call, {
        primary: input.options.llmClient,
        fallback: input.options.fallbackLlmClient ?? undefined,
      });
    } catch (error) {
      if (error instanceof ReaderLlmInvalidOutputError) {
        throw new ReaderLlmInvalidOutputError(
          roundedCost(totalCost + error.costUsd),
          { cause: error },
        );
      }
      if (error instanceof ReaderLlmProviderError) {
        throw new ReaderLlmProviderError(
          roundedCost(totalCost + error.costUsd),
          { cause: error },
        );
      }
      throw error;
    }
    totalCost = roundedCost(totalCost + slice.costUsd);
    primaryCost = roundedCost(primaryCost + slice.primaryCostUsd);
    fallbackCost = roundedCost(fallbackCost + slice.fallbackCostUsd);
    pagesRead += slice.pagesRead;
    attempts = Math.max(attempts, slice.attempts);
    zodAttempts += slice.zodAttempts;
    fallbackUsed ||= slice.fallbackUsed;
    if (slice.text) parts.push(slice.text);
    chunkNotes.push({
      entry: input.document.fileName,
      kind: "pdf",
      status: "chunk_read",
      pages: chunk.pages,
      pageCount: chunk.pageCount,
      costUsd: slice.costUsd,
      attempts: slice.attempts,
      fallbackUsed: slice.fallbackUsed,
      zodAttempts: slice.zodAttempts,
    });
  }
  const text = parts.join("\n\n").trim();
  const audit = await maybeAuditPiece(
    calls,
    { text, pagesRead, fallbackUsed },
    input.options,
  );
  return {
    kind: "pdf",
    status: text ? "extracted_ocr" : "empty_text",
    text,
    modelCostUsd: totalCost,
    pagesRead,
    modelAttempts: attempts,
    fallbackUsed,
    zodAttempts,
    primaryCostUsd: primaryCost,
    fallbackCostUsd: fallbackCost,
    ...(audit ? { audit } : {}),
    notes: [
      {
        entry: input.document.fileName,
        kind: "pdf",
        status: text ? "extracted_ocr" : "empty_text",
        bytes: input.sentBytes.byteLength,
        sourceBytes: input.sourceBytes.byteLength,
        sentBytes: input.sentBytes.byteLength,
        ...(input.pageCount === undefined ? {} : { pageCount: input.pageCount }),
        ...(input.pages === undefined ? {} : { pages: input.pages }),
        fallbackUsed,
        zodAttempts,
      },
      ...chunkNotes,
      ...(audit ? [auditNote(input.document.fileName, audit)] : []),
    ],
  };
}

async function readPdf(
  document: LocalDocument,
  bytes: Uint8Array,
  options: LocalDocumentReaderOptions,
): Promise<LocalDocumentReadResult> {
  if (!pdfMagic(bytes)) return unsupported(document.fileName, bytes, "not_pdf_magic");
  let sentBytes = bytes;
  let pageCount: number | undefined;
  let pages: string | undefined;
  if (bytes.byteLength > options.maxModelBytes) {
    try {
      const subset = await copyPdfHeadTailPages(bytes, PDF_SUBSET);
      sentBytes = subset.bytes;
      pageCount = subset.pageCount;
      pages = subset.pages;
    } catch (error) {
      return {
        kind: "pdf",
        status: "too_large",
        text: "",
        modelCostUsd: 0,
        notes: [
          {
            entry: document.fileName,
            kind: "pdf",
            status: "too_large",
            bytes: bytes.byteLength,
            reason: `pdf_subset_failed:${error instanceof Error ? error.name : "unknown"}`,
          },
        ],
      };
    }
  }
  if (sentBytes.byteLength > options.maxModelBytes) {
    return {
      kind: "pdf",
      status: "too_large",
      text: "",
      modelCostUsd: 0,
      notes: [
        {
          entry: document.fileName,
          kind: "pdf",
          status: "too_large",
          sourceBytes: bytes.byteLength,
          sentBytes: sentBytes.byteLength,
          ...(pageCount === undefined ? {} : { pageCount }),
          ...(pages === undefined ? {} : { pages }),
          reason: "pdf_subset_too_large",
        },
      ],
    };
  }
  const role: DocumentReaderRole =
    options.knownRole ?? classifyAnalysisRole(document.fileName) ?? "inconnu";
  let chunks: PdfPageChunk[] | null = null;
  try {
    const split = await splitPdfIntoPageChunks(sentBytes, PDF_CHUNK_PAGES);
    if (split.length > 1) chunks = split;
  } catch {
    chunks = null;
  }
  if (chunks) {
    return readPdfInChunks({
      document,
      sourceBytes: bytes,
      sentBytes,
      chunks,
      role,
      options,
      ...(pageCount === undefined ? {} : { pageCount }),
      ...(pages === undefined ? {} : { pages }),
    });
  }
  const call: CascadePdfInput = {
    bytes: sentBytes,
    fileName: document.fileName,
    role,
  };
  const result = await readPdfWithModelCascade(call, {
    primary: options.llmClient,
    fallback: options.fallbackLlmClient ?? undefined,
  });
  const audit = await maybeAuditPiece(
    [call],
    {
      text: result.text,
      pagesRead: result.pagesRead,
      fallbackUsed: result.fallbackUsed,
    },
    options,
  );
  return {
    kind: "pdf",
    status: result.text ? "extracted_ocr" : "empty_text",
    text: result.text,
    modelCostUsd: result.costUsd,
    pagesRead: result.pagesRead,
    modelAttempts: result.attempts,
    fallbackUsed: result.fallbackUsed,
    zodAttempts: result.zodAttempts,
    primaryCostUsd: result.primaryCostUsd,
    fallbackCostUsd: result.fallbackCostUsd,
    ...(audit ? { audit } : {}),
    notes: [
      {
        entry: document.fileName,
        kind: "pdf",
        status: result.text ? "extracted_ocr" : "empty_text",
        bytes: sentBytes.byteLength,
        sourceBytes: bytes.byteLength,
        sentBytes: sentBytes.byteLength,
        ...(pageCount === undefined ? {} : { pageCount }),
        ...(pages === undefined ? {} : { pages }),
        fallbackUsed: result.fallbackUsed,
        zodAttempts: result.zodAttempts,
      },
      ...(audit ? [auditNote(document.fileName, audit)] : []),
    ],
  };
}

export async function readLocalDocument(
  document: LocalDocument,
  options: LocalDocumentReaderOptions,
): Promise<LocalDocumentReadResult> {
  const size = (await stat(document.path)).size;
  if (size === 0) {
    return {
      kind: "unknown",
      status: "empty_file",
      text: "",
      modelCostUsd: 0,
      notes: [
        {
          entry: document.fileName,
          kind: "unknown",
          status: "empty_file",
          bytes: 0,
        },
      ],
    };
  }
  const bytes = new Uint8Array(await readFile(document.path));
  const kind = detectDocumentKind(document.fileName, bytes);
  if (kind === "pdf") return readPdf(document, bytes, options);
  if (kind === "docx") return readDocx(bytes, document.fileName);
  if (kind === "doc") {
    return readLegacyDoc(bytes, document.fileName, options.legacyDocExtractor);
  }
  if (kind === "spreadsheet") return readSpreadsheet(bytes, document.fileName);
  if (kind === "zip") {
    return unsupported(document.fileName, bytes, "zip_requires_archive_reader");
  }
  return unsupported(
    document.fileName,
    bytes,
    normalize(document.fileName).endsWith(".pdf")
      ? "not_pdf_magic"
      : "unsupported_document_kind",
  );
}
