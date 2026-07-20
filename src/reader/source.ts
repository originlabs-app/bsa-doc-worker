import { join } from "node:path";

import type { ReaderDocumentSource } from "./pipeline.js";
import { downloadStorageObjectToFile } from "./download.js";
import { downloadNukemaSourceToFile } from "./nukema.js";

function safeTargetName(documentId: string, fileName: string): string {
  const sanitized = fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 180);
  return `${documentId}-${sanitized || "attachment"}`;
}

export function createReaderDocumentSource(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  nukemaUsername: string;
  nukemaPassword: string;
  maxBytes: number;
  fetchFn?: typeof fetch;
}): ReaderDocumentSource {
  return {
    async download(claim, tempDirectory, onProgress, signal) {
      const targetPath = join(
        tempDirectory,
        safeTargetName(claim.document_id, claim.file_name),
      );
      const result = claim.source_reference?.trim() || claim.source_url?.trim()
        ? await downloadNukemaSourceToFile({
            username: input.nukemaUsername,
            password: input.nukemaPassword,
            sourceReference: claim.source_reference,
            sourceUrl: claim.source_url,
            fileName: claim.file_name,
            targetPath,
            maxBytes: input.maxBytes,
            signal,
            onProgress,
            ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
          })
        : await downloadStorageObjectToFile({
            supabaseUrl: input.supabaseUrl,
            serviceRoleKey: input.serviceRoleKey,
            objectPath: claim.url,
            targetPath,
            maxBytes: input.maxBytes,
            signal,
            onProgress,
            ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
          });
      return { path: targetPath, ...result };
    },
  };
}
