import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { AdapterPlatform } from "./contracts.js";
import type {
  DocumentIngestionSink,
  DownloadReceipt,
  EphemeralAttachment,
} from "./ports.js";

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

  constructor() {
    super("DOWNLOAD_INCOMPLETE");
    this.name = "DownloadError";
  }
}

function failDownload(): never {
  throw new DownloadError();
}

function isHostOrSubdomain(hostname: string, rootHost: string): boolean {
  return hostname === rootHost || hostname.endsWith(`.${rootHost}`);
}

function isPortalAttachmentUrl(url: URL, rootHost: string): boolean {
  return (
    url.protocol === "https:" &&
    isHostOrSubdomain(url.hostname, rootHost) &&
    /(dce|document|pi[eè]ce|attachment|download|t[eé]l[eé]charg)/i.test(
      url.pathname,
    )
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
    failDownload();
  }
  let currentUrl = initialUrl;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetcher(currentUrl, {
      headers: safeHeaders(
        attachment.requestHeaders,
        initialUrl.hostname,
        currentUrl.hostname,
      ),
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirect === MAX_REDIRECTS) failDownload();
    const nextUrl = new URL(location, currentUrl);
    if (!isAllowedAttachmentUrl(nextUrl, attachment.sourcePlatform)) {
      failDownload();
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
  const response = await fetchAllowlisted(attachment, fetcher);
  if (!response.ok || !response.body) failDownload();
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) failDownload();
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) failDownload();

  const quarantine = await sink.open(attachment);
  const hash = createHash("sha256");
  let bytes = 0;
  let preview = Buffer.alloc(0);
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        callback(new DownloadError());
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
      failDownload();
    }
    if (attachment.expectedSize !== null && attachment.expectedSize !== bytes) {
      failDownload();
    }
    await quarantine.validate();
    const receipt: DownloadReceipt = {
      stableId: attachment.stableId,
      bytes,
      sha256: hash.digest("hex"),
    };
    await quarantine.commit(receipt);
    return receipt;
  } catch {
    await quarantine.abort().catch(() => undefined);
    throw new DownloadError();
  }
}
