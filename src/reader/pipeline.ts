import { createHash } from "node:crypto";
import { open, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  ReaderLlmInvalidOutputError,
  ReaderLlmProviderError,
  type StructuredPdfClient,
} from "../llm/document-reader.js";
import type { WorkerLogger } from "../logger.js";
import { extractZipLeaves, ReaderArchiveError } from "./archive.js";
import {
  classifyAnalysisRole,
  classifyAnalysisRoleFromText,
} from "./classification.js";
import type { ReaderConfig, ReaderMode } from "./config.js";
import { ReaderDownloadError } from "./download.js";
import {
  NukemaSourceExpiredError,
  NukemaSourceUnavailableError,
} from "./nukema.js";
import { detectDocumentKind, readLocalDocument } from "./readers.js";
import { buildDceTextPath } from "./storage.js";
import {
  ReaderClaimLostError,
  type ReaderStore,
} from "./supabase.js";
import type {
  AiSpendDraft,
  AnalysisRole,
  ClaimedDocument,
  ExtractionNote,
  ExtractionStatus,
} from "./types.js";

export interface DownloadedReaderDocument {
  path: string;
  bytes: number;
  contentType: string;
}

export interface ReaderDocumentSource {
  download(
    claim: ClaimedDocument,
    tempDirectory: string,
    onProgress: (bytesRead: number) => Promise<void> | void,
    signal: AbortSignal,
  ): Promise<DownloadedReaderDocument>;
}

export interface ReaderPipelineDependencies {
  store: ReaderStore;
  source: ReaderDocumentSource;
  llmClient: StructuredPdfClient;
  workerId: string;
  logger?: WorkerLogger;
  modeSource?: () => ReaderMode;
}

export interface ReaderDocumentReport {
  queueId: string;
  tenderId: string;
  documentId: string;
  status: string;
  costUsd: number;
  durationMs: number;
  issue?: string;
}

export interface ReaderTickReport {
  mode: ReaderMode;
  claimed: number;
  processed: number;
  failed: number;
  released: number;
  results: ReaderDocumentReport[];
}

class ReaderModeStoppedError extends Error {
  readonly code = "READER_MODE_STOPPED";
}

export class ReaderZipNoReadableLeafError extends Error {
  readonly code = "READER_ZIP_NO_READABLE_LEAF";

  constructor(
    public readonly costUsd: number,
    public readonly notes: ExtractionNote[],
    options?: ErrorOptions,
  ) {
    super("READER_ZIP_NO_READABLE_LEAF", options);
    this.name = "ReaderZipNoReadableLeafError";
  }
}

function currentMode(
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
): ReaderMode {
  return dependencies.modeSource?.() ?? config.mode;
}

function assertMode(
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
  expected: ReaderMode,
): void {
  if (currentMode(config, dependencies) !== expected) {
    throw new ReaderModeStoppedError("READER_MODE_STOPPED");
  }
}

function shortIssue(error: unknown): string {
  if (error instanceof ReaderArchiveError) return error.code;
  if (error instanceof ReaderLlmInvalidOutputError) return error.code;
  if (error instanceof ReaderLlmProviderError) return error.code;
  if (error instanceof ReaderZipNoReadableLeafError) return error.code;
  if (error instanceof ReaderModeStoppedError) return error.code;
  if (error instanceof ReaderClaimLostError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)) {
    return error.message;
  }
  return "READER_PROCESSING_FAILED";
}

function failureNotes(
  claim: ClaimedDocument,
  issue: string,
  error?: unknown,
): ExtractionNote[] {
  if (error instanceof ReaderZipNoReadableLeafError && error.notes.length) {
    return error.notes;
  }
  return [
    {
      entry: claim.file_name,
      kind: claim.file_name.toLowerCase().endsWith(".zip") ? "zip" : "unknown",
      status: "failed",
      reason: issue,
    },
  ];
}

function leafKind(fileName: string): ExtractionNote["kind"] {
  const name = fileName.toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".doc")) return "doc";
  if (/\.(csv|xls|xlsx|ods)$/.test(name)) return "spreadsheet";
  if (name.endsWith(".zip")) return "zip";
  return "unknown";
}

function sourceNotes(
  claim: ClaimedDocument,
  status: "source_expired" | "source_unavailable",
  issue: string,
): ExtractionNote[] {
  return [
    {
      entry: claim.file_name,
      kind: "unknown",
      status,
      reason:
        status === "source_expired"
          ? `${issue}; source expirée — à redemander côté Nukema`
          : `${issue}; pièce indisponible côté Nukema`,
    },
  ];
}

function terminalNotes(
  claim: ClaimedDocument,
  status: "too_large",
  issue: string,
): ExtractionNote[] {
  return [
    {
      entry: claim.file_name,
      kind: claim.file_name.toLowerCase().endsWith(".zip") ? "zip" : "unknown",
      status,
      reason: issue,
    },
  ];
}

function readable(status: ExtractionStatus): boolean {
  return ["extracted", "word_extracted", "extracted_ocr"].includes(status);
}

function sanitizeFileName(fileName: string): string {
  const clean = basename(fileName)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 200);
  return clean && !/^\.+$/.test(clean) ? clean : "attachment";
}

function materializedNames(
  leaves: Array<{ entryPath: string; fileName: string }>,
): Map<string, string> {
  const bases = leaves.map((leaf) => sanitizeFileName(leaf.fileName));
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  return new Map(
    leaves.map((leaf, index) => {
      const base = bases[index] ?? "attachment";
      if ((counts.get(base) ?? 0) === 1) return [leaf.entryPath, base];
      const digest = createHash("sha256")
        .update(leaf.entryPath)
        .digest("hex")
        .slice(0, 8);
      const dot = base.lastIndexOf(".");
      const extension = dot > 0 ? base.slice(dot) : "";
      const stem = (dot > 0 ? base.slice(0, dot) : base).slice(
        0,
        Math.max(1, 190 - extension.length),
      );
      return [leaf.entryPath, `${stem}--${digest}${extension}`];
    }),
  );
}

function contentType(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === "doc") return "application/msword";
  if (extension === "xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (extension === "xls") return "application/vnd.ms-excel";
  return "text/plain";
}

async function firstBytes(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const bytes = new Uint8Array(4);
    const { bytesRead } = await handle.read(bytes, 0, 4, 0);
    return bytes.slice(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function spendDraft(input: {
  claim: ClaimedDocument;
  config: ReaderConfig;
  costUsd: number;
  fileName: string;
  role: AnalysisRole | "inconnu";
  entryPath?: string;
}): AiSpendDraft {
  return {
    tenderId: input.claim.tender_id,
    model: input.config.model,
    costUsd: input.costUsd,
    metadata: {
      queue_id: input.claim.queue_id,
      document_id: input.claim.document_id,
      file_name: input.fileName,
      role: input.role,
      ...(input.entryPath ? { entry_path: input.entryPath } : {}),
    },
  };
}

async function recordSpend(
  draft: AiSpendDraft,
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
): Promise<void> {
  if (draft.costUsd <= 0) return;
  assertMode(config, dependencies, "apply");
  await dependencies.store.recordSpend(draft);
}

async function processRegularDocument(
  claim: ClaimedDocument,
  downloaded: DownloadedReaderDocument,
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
  mode: "dry_run" | "apply",
) {
  const result = await readLocalDocument(
    { path: downloaded.path, fileName: claim.file_name },
    {
      llmClient: dependencies.llmClient,
      knownRole: claim.analysis_role,
      maxModelBytes: config.maxModelBytes,
    },
  );
  const role = claim.analysis_role ?? classifyAnalysisRole(claim.file_name) ?? "inconnu";
  if (mode === "apply") {
    await recordSpend(
      spendDraft({
        claim,
        config,
        costUsd: result.modelCostUsd,
        fileName: claim.file_name,
        role,
      }),
      config,
      dependencies,
    );
    let textStoragePath: string | null = null;
    if (result.text) {
      textStoragePath = buildDceTextPath({
        url: claim.url,
        tenderId: claim.tender_id,
        documentId: claim.document_id,
        companyId: claim.company_id,
      });
      assertMode(config, dependencies, "apply");
      await dependencies.store.assertClaim(claim.queue_id, dependencies.workerId);
      await dependencies.store.uploadText(textStoragePath, result.text);
    }
    assertMode(config, dependencies, "apply");
    await dependencies.store.complete({
      queueId: claim.queue_id,
      workerId: dependencies.workerId,
      extractionStatus: result.status,
      textStoragePath,
      model: result.modelCostUsd > 0 ? config.model : null,
      costUsd: result.modelCostUsd,
      notes: result.notes,
    });
  }
  return {
    status: result.status,
    costUsd: result.modelCostUsd,
    notes: result.notes,
  };
}

async function processZipDocument(
  claim: ClaimedDocument,
  downloaded: DownloadedReaderDocument,
  tempDirectory: string,
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
  mode: "dry_run" | "apply",
) {
  const archive = await extractZipLeaves(downloaded.path, tempDirectory);
  const names = materializedNames(archive.leaves);
  const notes = [...archive.notes];
  let totalCost = 0;
  let hasReadableChild = false;
  let failedLeaves = 0;
  let firstLeafError: unknown;

  for (const leaf of archive.leaves) {
    const fileName = names.get(leaf.entryPath) ?? sanitizeFileName(leaf.fileName);
    const fileRole = classifyAnalysisRole(leaf.entryPath);
    let result;
    try {
      result = await readLocalDocument(
        { path: leaf.path, fileName: leaf.fileName },
        {
          llmClient: dependencies.llmClient,
          knownRole: fileRole,
          maxModelBytes: config.maxModelBytes,
        },
      );
    } catch (error) {
      const reason = shortIssue(error);
      const failureCost =
        (error instanceof ReaderLlmInvalidOutputError ||
          error instanceof ReaderLlmProviderError) &&
        error.costUsd > 0
          ? error.costUsd
          : 0;
      failedLeaves += 1;
      firstLeafError ??= error;
      totalCost += failureCost;
      notes.push({
        entry: leaf.entryPath,
        kind: leafKind(leaf.fileName),
        status: "failed",
        bytes: leaf.bytes,
        depth: leaf.depth,
        reason,
        ...(failureCost > 0 ? { costUsd: failureCost } : {}),
      });
      if (mode === "apply" && failureCost > 0) {
        await recordSpend(
          spendDraft({
            claim,
            config,
            costUsd: failureCost,
            fileName: leaf.fileName,
            role: fileRole ?? "inconnu",
            entryPath: leaf.entryPath,
          }),
          config,
          dependencies,
        );
      }
      continue;
    }
    totalCost += result.modelCostUsd;
    notes.push(
      ...result.notes.map((note) => ({
        ...note,
        entry: leaf.entryPath,
        depth: leaf.depth,
      })),
    );
    hasReadableChild ||= readable(result.status) && Boolean(result.text);

    let role = fileRole;
    let roleSource: "filename" | "content" | null = role ? "filename" : null;
    if (!role && result.text) {
      role = classifyAnalysisRoleFromText(result.text);
      roleSource = role ? "content" : null;
    }

    if (mode !== "apply") continue;
    await recordSpend(
      spendDraft({
        claim,
        config,
        costUsd: result.modelCostUsd,
        fileName: leaf.fileName,
        role: role ?? "inconnu",
        entryPath: leaf.entryPath,
      }),
      config,
      dependencies,
    );
    assertMode(config, dependencies, "apply");
    const child = await dependencies.store.upsertZipChild({
      queueId: claim.queue_id,
      workerId: dependencies.workerId,
      entryPath: leaf.entryPath,
      fileName,
      analysisRole: role,
      analysisRoleSource: roleSource,
      extractionStatus: result.status,
    });
    await dependencies.store.assertClaim(claim.queue_id, dependencies.workerId);
    await dependencies.store.uploadObject(
      child.url,
      new Uint8Array(await readFile(leaf.path)),
      contentType(leaf.fileName),
    );
    if (result.text) {
      await dependencies.store.assertClaim(claim.queue_id, dependencies.workerId);
      await dependencies.store.uploadText(
        buildDceTextPath({
          url: child.url,
          tenderId: child.tender_id,
          documentId: child.document_id,
          companyId: claim.company_id,
        }),
        result.text,
      );
    }
  }

  if (failedLeaves > 0 && !hasReadableChild) {
    throw new ReaderZipNoReadableLeafError(totalCost, notes, {
      cause: firstLeafError,
    });
  }

  const status: ExtractionStatus = hasReadableChild
    ? "extracted"
    : archive.leaves.length
      ? "empty_text"
      : "empty_file";
  if (mode === "apply") {
    assertMode(config, dependencies, "apply");
    await dependencies.store.complete({
      queueId: claim.queue_id,
      workerId: dependencies.workerId,
      extractionStatus: status,
      textStoragePath: null,
      model: totalCost > 0 ? config.model : null,
      costUsd: totalCost,
      notes,
    });
  }
  return { status, costUsd: totalCost, notes };
}

async function withHeartbeat<T>(
  claim: ClaimedDocument,
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  let heartbeatRunning = false;
  let heartbeatError: unknown;
  await dependencies.store.heartbeat(claim.queue_id, dependencies.workerId);
  const timer = setInterval(() => {
    if (heartbeatRunning || heartbeatError) return;
    heartbeatRunning = true;
    void dependencies.store
      .heartbeat(claim.queue_id, dependencies.workerId)
      .catch((error: unknown) => {
        heartbeatError = error;
        abort.abort(error);
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, config.heartbeatMs);
  timer.unref();
  try {
    const result = await work(abort.signal);
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    clearInterval(timer);
  }
}

async function processClaim(
  claim: ClaimedDocument,
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
  mode: "dry_run" | "apply",
): Promise<ReaderDocumentReport> {
  const startedAt = Date.now();
  const tempDirectory = await mkdtemp(join(tmpdir(), "bsa-reader-"));
  try {
    const output = await withHeartbeat(
      claim,
      config,
      dependencies,
      async (signal) => {
        assertMode(config, dependencies, mode);
        const downloaded = await dependencies.source.download(
          claim,
          tempDirectory,
          () => undefined,
          signal,
        );
        const kind = detectDocumentKind(claim.file_name, await firstBytes(downloaded.path));
        return kind === "zip"
          ? processZipDocument(
              claim,
              downloaded,
              tempDirectory,
              config,
              dependencies,
              mode,
            )
          : processRegularDocument(claim, downloaded, config, dependencies, mode);
      },
    );
    if (mode === "dry_run") {
      await dependencies.store.release(
        claim.queue_id,
        dependencies.workerId,
        "DRY_RUN_RELEASE",
        output.notes,
      );
    }
    return {
      queueId: claim.queue_id,
      tenderId: claim.tender_id,
      documentId: claim.document_id,
      status: output.status,
      costUsd: output.costUsd,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const issue = shortIssue(error);
    if (error instanceof ReaderClaimLostError) {
      return {
        queueId: claim.queue_id,
        tenderId: claim.tender_id,
        documentId: claim.document_id,
        status: "claim_lost",
        costUsd: 0,
        durationMs: Date.now() - startedAt,
        issue,
      };
    }
    if (mode === "dry_run" || error instanceof ReaderModeStoppedError) {
      await dependencies.store.release(
        claim.queue_id,
        dependencies.workerId,
        issue,
        failureNotes(claim, issue, error),
      );
    } else {
      if (error instanceof ReaderDownloadError && error.code === "DOCUMENT_TOO_LARGE") {
        const notes = terminalNotes(claim, "too_large", issue);
        await dependencies.store.complete({
          queueId: claim.queue_id,
          workerId: dependencies.workerId,
          extractionStatus: "too_large",
          textStoragePath: null,
          model: null,
          costUsd: 0,
          notes,
        });
        return {
          queueId: claim.queue_id,
          tenderId: claim.tender_id,
          documentId: claim.document_id,
          status: "too_large",
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          issue,
        };
      }
      if (error instanceof NukemaSourceUnavailableError) {
        const notes = sourceNotes(claim, "source_unavailable", issue);
        await dependencies.store.complete({
          queueId: claim.queue_id,
          workerId: dependencies.workerId,
          extractionStatus: "source_expired",
          textStoragePath: null,
          model: null,
          costUsd: 0,
          notes,
        });
        return {
          queueId: claim.queue_id,
          tenderId: claim.tender_id,
          documentId: claim.document_id,
          status: "source_expired",
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          issue,
        };
      }
      if (error instanceof NukemaSourceExpiredError) {
        const notes = sourceNotes(claim, "source_expired", issue);
        if (claim.attempts >= 2) {
          await dependencies.store.complete({
            queueId: claim.queue_id,
            workerId: dependencies.workerId,
            extractionStatus: "source_expired",
            textStoragePath: null,
            model: null,
            costUsd: 0,
            notes,
          });
          return {
            queueId: claim.queue_id,
            tenderId: claim.tender_id,
            documentId: claim.document_id,
            status: "source_expired",
            costUsd: 0,
            durationMs: Date.now() - startedAt,
            issue,
          };
        }
        await dependencies.store.defer(
          claim.queue_id,
          dependencies.workerId,
          issue,
          notes,
          24 * 60 * 60,
        );
        return {
          queueId: claim.queue_id,
          tenderId: claim.tender_id,
          documentId: claim.document_id,
          status: "source_expired_deferred",
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          issue,
        };
      }
      if (error instanceof ReaderLlmInvalidOutputError && error.costUsd > 0) {
        await recordSpend(
          spendDraft({
            claim,
            config,
            costUsd: error.costUsd,
            fileName: claim.file_name,
            role: claim.analysis_role ?? "inconnu",
          }),
          config,
          dependencies,
        );
      }
      if (error instanceof ReaderLlmProviderError) {
        if (error.costUsd > 0) {
          await recordSpend(
            spendDraft({
              claim,
              config,
              costUsd: error.costUsd,
              fileName: claim.file_name,
              role: claim.analysis_role ?? "inconnu",
            }),
            config,
            dependencies,
          );
        }
        const notes: ExtractionNote[] = [
          {
            entry: claim.file_name,
            kind: "pdf",
            status: "provider_transient",
            reason: issue,
          },
        ];
        await dependencies.store.release(
          claim.queue_id,
          dependencies.workerId,
          issue,
          notes,
        );
        return {
          queueId: claim.queue_id,
          tenderId: claim.tender_id,
          documentId: claim.document_id,
          status: "transient_deferred",
          costUsd: error.costUsd,
          durationMs: Date.now() - startedAt,
          issue,
        };
      }
      await dependencies.store.fail(
        claim.queue_id,
        dependencies.workerId,
        issue,
        failureNotes(claim, issue, error),
      );
    }
    return {
      queueId: claim.queue_id,
      tenderId: claim.tender_id,
      documentId: claim.document_id,
      status: mode === "dry_run" ? "released" : "failed",
      costUsd:
        error instanceof ReaderLlmInvalidOutputError ||
        error instanceof ReaderZipNoReadableLeafError
          ? error.costUsd
          : 0,
      durationMs: Date.now() - startedAt,
      issue,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function runReaderTick(
  config: ReaderConfig,
  dependencies: ReaderPipelineDependencies,
): Promise<ReaderTickReport> {
  const mode = currentMode(config, dependencies);
  const report: ReaderTickReport = {
    mode,
    claimed: 0,
    processed: 0,
    failed: 0,
    released: 0,
    results: [],
  };
  if (mode === "off") return report;

  const seenQueueIds = new Set<string>();
  for (let index = 0; index < config.batch; index += 1) {
    if (currentMode(config, dependencies) === "off") break;
    const claim = await dependencies.store.claimNext(dependencies.workerId);
    if (!claim) break;
    report.claimed += 1;
    if (mode === "dry_run" && seenQueueIds.has(claim.queue_id)) {
      await dependencies.store.release(
        claim.queue_id,
        dependencies.workerId,
        "DRY_RUN_DUPLICATE_CLAIM",
        [],
      );
      break;
    }
    seenQueueIds.add(claim.queue_id);
    const result = await processClaim(claim, config, dependencies, mode);
    report.results.push(result);
    if (result.status === "failed") report.failed += 1;
    else if (result.status !== "claim_lost") report.processed += 1;
    if (mode === "dry_run") report.released += 1;
    dependencies.logger?.info("reader_document_finished", {
      queue_id: result.queueId,
      tender_id: result.tenderId,
      document_id: result.documentId,
      duration_ms: result.durationMs,
      cost_usd: result.costUsd,
      status: result.status,
      issue: result.issue ?? null,
    });
  }
  return report;
}
