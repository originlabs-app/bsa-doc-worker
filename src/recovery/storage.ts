import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { RecoveryObjectStorage } from "./pipeline.js";

const STORAGE_BUCKET = "appel-offre-documents";
const STORAGE_TIMEOUT_MS = 10 * 60 * 1_000;

function encodedObjectPath(objectPath: string): string {
  const segments = objectPath.split("/");
  if (
    segments.length !== 3 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("RECOVERY_STORAGE_PATH_INVALID");
  }
  return segments.map(encodeURIComponent).join("/");
}

function authHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

async function duplicateResponse(response: Response): Promise<boolean> {
  if (response.status === 409) return true;
  if (response.status !== 400) return false;
  const text = await response.text();
  return text.length <= 4_096 && /duplicate|already exists|409/i.test(text);
}

export function createSupabaseRecoveryStorage(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetcher?: typeof fetch;
}): RecoveryObjectStorage {
  const baseUrl = input.supabaseUrl.replace(/\/$/, "");
  const fetcher = input.fetcher ?? fetch;
  return {
    async upload({ objectPath, localPath, contentType, bytes }) {
      const metadata = await stat(localPath);
      if (!metadata.isFile() || metadata.size !== bytes || bytes <= 0) {
        throw new Error("RECOVERY_STORAGE_SOURCE_INVALID");
      }
      const response = await fetcher(
        `${baseUrl}/storage/v1/object/${STORAGE_BUCKET}/${encodedObjectPath(objectPath)}`,
        {
          method: "POST",
          headers: {
            ...authHeaders(input.serviceRoleKey),
            "content-type": contentType,
            "content-length": String(bytes),
            "x-upsert": "false",
          },
          body: createReadStream(localPath) as unknown as BodyInit,
          redirect: "error",
          signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
          duplex: "half",
        } as RequestInit & { duplex: "half" },
      );
      if (response.ok) {
        await response.body?.cancel();
        return { created: true };
      }
      if (await duplicateResponse(response)) return { created: false };
      throw new Error("RECOVERY_STORAGE_UPLOAD_FAILED");
    },

    async remove(objectPaths) {
      if (objectPaths.length === 0) return;
      objectPaths.forEach(encodedObjectPath);
      const response = await fetcher(
        `${baseUrl}/storage/v1/object/${STORAGE_BUCKET}`,
        {
          method: "DELETE",
          headers: {
            ...authHeaders(input.serviceRoleKey),
            "content-type": "application/json",
          },
          body: JSON.stringify({ prefixes: objectPaths }),
          redirect: "error",
          signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error("RECOVERY_STORAGE_ROLLBACK_FAILED");
      await response.body?.cancel();
    },
  };
}
