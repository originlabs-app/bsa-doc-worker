import { open, rm } from "node:fs/promises";

export class ReaderDownloadError extends Error {
  constructor(
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ReaderDownloadError";
  }
}

async function writeComplete(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    if (bytesWritten === 0) throw new ReaderDownloadError("DOCUMENT_WRITE_STALLED");
    offset += bytesWritten;
  }
}

export async function streamResponseToFile(
  response: Response,
  targetPath: string,
  maxBytes: number,
  onProgress?: (bytesRead: number) => Promise<void> | void,
): Promise<number> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ReaderDownloadError("DOCUMENT_TOO_LARGE");
  }
  if (!response.body) throw new ReaderDownloadError("DOCUMENT_BODY_MISSING");

  const handle = await open(targetPath, "wx", 0o600);
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ReaderDownloadError("DOCUMENT_TOO_LARGE");
      }
      await writeComplete(handle, value);
      await onProgress?.(total);
    }
    return total;
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

function encodeStoragePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function buildStorageObjectUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/appel-offre-documents/${encodeStoragePath(path)}`;
}

export async function downloadStorageObjectToFile(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  objectPath: string;
  targetPath: string;
  maxBytes: number;
  onProgress?: (bytesRead: number) => Promise<void> | void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}): Promise<{ bytes: number; contentType: string }> {
  const response = await (input.fetchFn ?? fetch)(
    buildStorageObjectUrl(input.supabaseUrl, input.objectPath),
    {
      headers: {
        apikey: input.serviceRoleKey,
        Authorization: `Bearer ${input.serviceRoleKey}`,
      },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ReaderDownloadError(`STORAGE_DOWNLOAD_${response.status}`);
  }
  return {
    bytes: await streamResponseToFile(
      response,
      input.targetPath,
      input.maxBytes,
      input.onProgress,
    ),
    contentType: response.headers.get("content-type") ?? "",
  };
}
