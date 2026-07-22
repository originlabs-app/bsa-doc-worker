import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { isAtexoDownloadActionUrl } from "./adapters/atexo.js";
import type { AdapterPlatform } from "./contracts.js";
import type {
  DocumentIngestionSink,
  DownloadReceipt,
  EphemeralAttachment,
} from "./ports.js";
import { sanitizeRecoveryFailureMessage } from "./recovery/failure.js";
import type { RecoveryFailureType } from "./recovery/contracts.js";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;

type Fetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface StreamAttachmentOptions {
  fetcher?: Fetcher;
  maxBytes?: number;
}

export class DownloadError extends Error {
  readonly reasonCode = "DOWNLOAD_INCOMPLETE" as const;
  readonly failureStage = "download" as const;
  readonly failureType: RecoveryFailureType;
  readonly failureMessage: string;
  readonly retryable: boolean;

  constructor(
    readonly kind: "incomplete" | "too_large" = "incomplete",
    options: {
      type?: RecoveryFailureType;
      message?: string;
      retryable?: boolean;
    } = {},
  ) {
    super("DOWNLOAD_INCOMPLETE");
    this.name = "DownloadError";
    this.failureType = options.type ??
      (kind === "too_large" ? "validation" : "download");
    this.failureMessage = sanitizeRecoveryFailureMessage(
      options.message ??
        (kind === "too_large"
          ? "Attachment exceeds the configured byte limit"
          : "Attachment download is incomplete"),
    );
    this.retryable = options.retryable ?? kind !== "too_large";
  }
}

function failDownload(
  kind: "incomplete" | "too_large" = "incomplete",
  options: ConstructorParameters<typeof DownloadError>[1] = {},
): never {
  throw new DownloadError(kind, options);
}

function isHostOrSubdomain(hostname: string, rootHost: string): boolean {
  return hostname === rootHost || hostname.endsWith(`.${rootHost}`);
}

function isPortalAttachmentUrl(url: URL, rootHost: string): boolean {
  if (url.protocol !== "https:" || !isHostOrSubdomain(url.hostname, rootHost)) {
    return false;
  }
  return (
    /(dce|document|pi[eè]ce|attachment|download|t[eé]l[eé]charg)/i.test(
      url.pathname,
    ) || isAtexoDownloadActionUrl(url)
  );
}

function isAllowedAttachmentUrl(
  url: URL,
  sourcePlatform: AdapterPlatform | undefined,
): boolean {
  if (url.protocol !== "https:") return false;
  if (sourcePlatform === "place") {
    return isPortalAttachmentUrl(url, "marches-publics.gouv.fr");
  }
  if (sourcePlatform === "maximilien") {
    return isPortalAttachmentUrl(url, "marches.maximilien.fr");
  }
  if (
    url.hostname === "downloads.awsolutions.fr" &&
    url.pathname.startsWith("/dce/attachment/")
  ) {
    return true;
  }
  const isAwsHost =
    url.hostname === "marches-publics.info" ||
    url.hostname.endsWith(".marches-publics.info");
  return (
    isAwsHost &&
    (url.searchParams.get("fuseaction") ?? "").toLowerCase() === "dce.tdoc"
  );
}

function safeHeaders(
  headers: Readonly<Record<string, string>>,
  initialHost: string,
  currentHost: string,
): Record<string, string> {
  const result = { ...headers };
  if (
    currentHost !== initialHost ||
    currentHost === "downloads.awsolutions.fr"
  ) {
    for (const key of Object.keys(result)) {
      if (key.toLowerCase() === "cookie") delete result[key];
    }
  }
  return result;
}

async function fetchAllowlisted(
  attachment: EphemeralAttachment,
  fetcher: Fetcher,
): Promise<Response> {
  const initialUrl = new URL(attachment.downloadUrl);
  if (!isAllowedAttachmentUrl(initialUrl, attachment.sourcePlatform)) {
    failDownload("incomplete", {
      message: "Attachment URL is outside the portal allowlist",
      retryable: false,
    });
  }
  let currentUrl = initialUrl;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    let response: Response;
    try {
      response = await fetcher(currentUrl, {
        headers: safeHeaders(
          attachment.requestHeaders,
          initialUrl.hostname,
          currentUrl.hostname,
        ),
        redirect: "manual",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failDownload("incomplete", {
        type: "network",
        message: `Attachment request failed: ${message}`,
        retryable: true,
      });
    }
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirect === MAX_REDIRECTS) {
      failDownload("incomplete", {
        message: "Attachment redirect chain is incomplete",
      });
    }
    const nextUrl = new URL(location, currentUrl);
    if (!isAllowedAttachmentUrl(nextUrl, attachment.sourcePlatform)) {
      failDownload("incomplete", {
        message: "Attachment redirect leaves the portal allowlist",
        retryable: false,
      });
    }
    currentUrl = nextUrl;
  }

  return failDownload();
}

function looksLikeHtml(bytes: Buffer): boolean {
  const beginning = bytes.toString("utf8").trimStart().toLowerCase();
  return (
    beginning.startsWith("<!doctype html") ||
    beginning.startsWith("<html") ||
    beginning.includes("<title>login") ||
    beginning.includes("textecaptcha")
  );
}

function hasExpectedMagic(
  kind: EphemeralAttachment["kind"],
  bytes: Buffer,
): boolean {
  if (kind === "pdf") return bytes.subarray(0, 5).toString() === "%PDF-";
  if (kind === "zip") {
    const signature = bytes.subarray(0, 4).toString("hex");
    return signature === "504b0304" || signature === "504b0506";
  }
  return !looksLikeHtml(bytes);
}

export async function streamAttachment(
  attachment: EphemeralAttachment,
  sink: DocumentIngestionSink,
  options: StreamAttachmentOptions = {},
): Promise<DownloadReceipt> {
  const fetcher = options.fetcher ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (
    attachment.expectedSize !== null &&
    attachment.expectedSize > maxBytes
  ) {
    failDownload("too_large");
  }
  const response = await fetchAllowlisted(attachment, fetcher);
  if (!response.ok) {
    failDownload("incomplete", {
      message: `Attachment returned HTTP ${response.status}`,
    });
  }
  if (!response.body) {
    failDownload("incomplete", { message: "Attachment response has no body" });
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    failDownload("incomplete", {
      message: "Attachment response is HTML instead of a document",
    });
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    failDownload("too_large");
  }

  const quarantine = await sink.open(attachment);
  const hash = createHash("sha256");
  let bytes = 0;
  let preview = Buffer.alloc(0);
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        callback(new DownloadError("too_large"));
        return;
      }
      hash.update(buffer);
      if (preview.byteLength < 512) {
        preview = Buffer.concat([preview, buffer]).subarray(0, 512);
      }
      if (looksLikeHtml(preview)) {
        callback(new DownloadError());
        return;
      }
      callback(null, buffer);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(
        response.body as unknown as NodeReadableStream<Uint8Array>,
      ),
      guard,
      quarantine.writable,
    );
    if (bytes === 0 || !hasExpectedMagic(attachment.kind, preview)) {
      failDownload("incomplete", {
        message: "Attachment content does not match the expected document type",
      });
    }
    if (attachment.expectedSize !== null && attachment.expectedSize !== bytes) {
      failDownload("incomplete", {
        message: "Attachment byte count does not match the manifest",
      });
    }
    await quarantine.validate();
    const receipt: DownloadReceipt = {
      stableId: attachment.stableId,
      bytes,
      sha256: hash.digest("hex"),
    };
    await quarantine.commit(receipt);
    return receipt;
  } catch (error) {
    await quarantine.abort().catch(() => undefined);
    if (error instanceof DownloadError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DownloadError("incomplete", {
      type: "network",
      message: `Attachment stream failed: ${message}`,
      retryable: true,
    });
  }
}
