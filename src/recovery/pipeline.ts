import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { DownloadError, streamAttachment } from "../download.js";
import type { WorkerLogger } from "../logger.js";
import type {
  DocumentIngestionSink,
  DownloadReceipt,
  QuarantineWrite,
} from "../ports.js";
import {
  RecoveryTooLargeError,
  type RecoveryDocumentPipeline,
  type RecoveryStoredDocument,
} from "./contracts.js";

export interface RecoveryObjectStorage {
  upload(input: {
    objectPath: string;
    localPath: string;
    contentType: string;
    bytes: number;
  }): Promise<{ created: boolean }>;
  remove(objectPaths: readonly string[]): Promise<void>;
}

export interface RecoveryDocumentPipelineOptions {
  storage: RecoveryObjectStorage;
  maxBytes: number;
  fetcher?: typeof fetch;
  logger?: WorkerLogger;
}

interface QuarantinedFile {
  fileName: string;
  localPath: string;
  receipt?: DownloadReceipt;
}

function safeFileName(raw: string, stableId: string): string {
  const printable = [...basename(raw)]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("")
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return printable || `attachment-${stableId.slice(0, 12)}`;
}

function allocateNames(
  attachments: readonly { stableId: string; fileName: string }[],
): Map<string, string> {
  const names = new Map<string, string>();
  const seen = new Set<string>();
  for (const attachment of attachments) {
    const initial = safeFileName(attachment.fileName, attachment.stableId);
    let allocated = initial;
    if (seen.has(initial.toLocaleLowerCase("fr"))) {
      const extension = extname(initial);
      const stem = extension ? initial.slice(0, -extension.length) : initial;
      allocated = `${stem}-${attachment.stableId.slice(0, 12)}${extension}`;
    }
    let collision = 1;
    while (seen.has(allocated.toLocaleLowerCase("fr"))) {
      const extension = extname(initial);
      const stem = extension ? initial.slice(0, -extension.length) : initial;
      allocated = `${stem}-${attachment.stableId.slice(0, 8)}-${collision}${extension}`;
      collision += 1;
    }
    seen.add(allocated.toLocaleLowerCase("fr"));
    names.set(attachment.stableId, allocated);
  }
  return names;
}

class FileQuarantineSink implements DocumentIngestionSink {
  readonly files = new Map<string, QuarantinedFile>();

  constructor(
    private readonly directory: string,
    private readonly names: ReadonlyMap<string, string>,
  ) {}

  async open(attachment: { stableId: string }): Promise<QuarantineWrite> {
    const fileName = this.names.get(attachment.stableId);
    if (!fileName) throw new Error("RECOVERY_MANIFEST_MISMATCH");
    const localPath = join(this.directory, attachment.stableId);
    const file: QuarantinedFile = { fileName, localPath };
    this.files.set(attachment.stableId, file);
    return {
      writable: createWriteStream(localPath, { flags: "wx", mode: 0o600 }),
      validate: async () => {
        const metadata = await stat(localPath);
        if (!metadata.isFile() || metadata.size <= 0) {
          throw new Error("RECOVERY_QUARANTINE_INVALID");
        }
      },
      commit: async (receipt) => {
        file.receipt = receipt;
      },
      abort: async () => {
        await rm(localPath, { force: true });
      },
    };
  }
}

function contentType(kind: "pdf" | "zip" | "unknown"): string {
  if (kind === "pdf") return "application/pdf";
  if (kind === "zip") return "application/zip";
  return "application/octet-stream";
}

function validateDiscovery(input: {
  safeManifest: { attachments: readonly { stableId: string }[] };
  ephemeralAttachments: readonly { stableId: string }[];
}): void {
  const safeIds = input.safeManifest.attachments.map(({ stableId }) => stableId);
  const ephemeralIds = input.ephemeralAttachments.map(({ stableId }) => stableId);
  if (
    safeIds.length === 0 ||
    safeIds.some(
      (stableId) => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(stableId),
    ) ||
    ephemeralIds.some(
      (stableId) => !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(stableId),
    ) ||
    safeIds.length !== new Set(safeIds).size ||
    ephemeralIds.length !== new Set(ephemeralIds).size ||
    safeIds.length !== ephemeralIds.length ||
    safeIds.some((stableId) => !ephemeralIds.includes(stableId))
  ) {
    throw new Error("RECOVERY_MANIFEST_MISMATCH");
  }
}

export function createRecoveryDocumentPipeline(
  options: RecoveryDocumentPipelineOptions,
): RecoveryDocumentPipeline {
  return {
    async fetchAndUpload({ target, match, discovery }) {
      validateDiscovery(discovery);
      const directory = await mkdtemp(join(tmpdir(), "bsa-dce-recovery-"));
      const names = allocateNames(discovery.safeManifest.attachments);
      const sink = new FileQuarantineSink(directory, names);
      const createdPaths: string[] = [];
      let disposed = false;
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        await rm(directory, { recursive: true, force: true });
      };
      const rollback = async () => {
        if (createdPaths.length > 0) {
          await options.storage.remove([...createdPaths]);
          createdPaths.length = 0;
        }
      };

      try {
        for (const attachment of discovery.ephemeralAttachments) {
          try {
            const receipt = await streamAttachment(attachment, sink, {
              ...(options.fetcher ? { fetcher: options.fetcher } : {}),
              maxBytes: options.maxBytes,
            });
            options.logger?.info("recovery_fetch_completed", {
              tender_id: target.tenderId,
              portal: match.candidate.portal,
              decision: match.level,
              stable_id: receipt.stableId,
              bytes: receipt.bytes,
            });
          } catch (error) {
            if (error instanceof DownloadError && error.kind === "too_large") {
              throw new RecoveryTooLargeError();
            }
            throw error;
          }
        }

        const documents: RecoveryStoredDocument[] = [];
        for (const attachment of discovery.ephemeralAttachments) {
          const quarantined = sink.files.get(attachment.stableId);
          if (!quarantined?.receipt) throw new Error("RECOVERY_QUARANTINE_MISSING");
          const objectPath =
            `${target.companyId}/${target.tenderId}/${quarantined.fileName}`;
          const uploaded = await options.storage.upload({
            objectPath,
            localPath: quarantined.localPath,
            contentType: contentType(attachment.kind),
            bytes: quarantined.receipt.bytes,
          });
          if (uploaded.created) createdPaths.push(objectPath);
          documents.push({
            fileName: quarantined.fileName,
            objectPath,
            sourceUrl: match.candidate.consultationUrl,
            sourceReference:
              `${match.candidate.portal}:${discovery.safeManifest.consultationId}:${attachment.stableId}`,
            bytes: quarantined.receipt.bytes,
            sha256: quarantined.receipt.sha256,
          });
        }
        return { documents, rollback, dispose };
      } catch (error) {
        await rollback().catch(() => undefined);
        await dispose().catch(() => undefined);
        throw error;
      }
    },
  };
}
