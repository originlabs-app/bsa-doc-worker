import { createHash } from "node:crypto";

import { load } from "cheerio";

import type {
  ReasonCode,
  RecoveryRequest,
  SafeManifestAttachment,
} from "../contracts.js";
import type {
  AdapterDiscovery,
  BuyerProfileAdapter,
  EphemeralAttachment,
} from "../ports.js";
import type {
  RecoveryFailureStage,
  RecoveryFailureType,
} from "../recovery/contracts.js";

export interface AwBrowserDiscovery {
  consultationUrl: string;
  consultationId: string;
  selectedLots: string[];
  listingHtml: string;
  cookieHeader: string;
  userAgent: string;
}

export interface AwBrowserSession {
  discover(request: RecoveryRequest): Promise<AwBrowserDiscovery>;
}

export class AwAdapterError extends Error {
  readonly failureStage: RecoveryFailureStage | undefined;
  readonly failureType: RecoveryFailureType | undefined;

  constructor(
    readonly reasonCode: ReasonCode,
    readonly retryable: boolean,
    message: string,
    metadata: {
      stage?: RecoveryFailureStage;
      type?: RecoveryFailureType;
    } = {},
  ) {
    super(message);
    this.name = "AwAdapterError";
    this.failureStage = metadata.stage;
    this.failureType = metadata.type;
  }
}

function sanitizeFileName(rawName: string, fallback: string): string {
  const printableName = [...rawName]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");
  const sanitized = printableName
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return sanitized || fallback;
}

function inferKind(fileName: string, sameHostDocument: boolean) {
  const lower = fileName.toLowerCase();
  if (sameHostDocument || lower.endsWith(".pdf")) return "pdf" as const;
  if (lower.endsWith(".zip")) return "zip" as const;
  return "unknown" as const;
}

function stableAttachmentId(
  consultationId: string,
  url: URL,
  fileName: string,
): string {
  return createHash("sha256")
    .update(["aw_solutions", consultationId, url.hostname, url.pathname, fileName].join("|"))
    .digest("hex")
    .slice(0, 24);
}

function expectedSize(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseAwListing(
  browserDiscovery: AwBrowserDiscovery,
): AdapterDiscovery {
  const sourceUrl = new URL(browserDiscovery.consultationUrl);
  const $ = load(browserDiscovery.listingHtml);
  const ephemeralAttachments: EphemeralAttachment[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    let url: URL;
    try {
      url = new URL(href, sourceUrl);
    } catch {
      return;
    }

    if (url.protocol !== "https:") return;

    const isDownloadHost =
      url.hostname === "downloads.awsolutions.fr" &&
      url.pathname.startsWith("/dce/attachment/");
    const isSameHostDocument =
      url.hostname === sourceUrl.hostname &&
      (url.searchParams.get("fuseaction") ?? "").toLowerCase() ===
        "dce.tdoc";
    if (!isDownloadHost && !isSameHostDocument) return;

    const anchorText = $(element).text().trim();
    const downloadName = $(element).attr("download")?.trim();
    const pathName = url.pathname.split("/").filter(Boolean).at(-1) ?? "attachment";
    let fileName = sanitizeFileName(downloadName || anchorText || pathName, "attachment");
    const kind = inferKind(fileName, isSameHostDocument);
    if (kind === "pdf" && !fileName.toLowerCase().endsWith(".pdf")) {
      fileName = `${fileName}.pdf`;
    }

    const stableId = stableAttachmentId(
      browserDiscovery.consultationId,
      url,
      fileName,
    );
    if (seen.has(stableId)) return;
    seen.add(stableId);

    const attachment: SafeManifestAttachment = {
      stableId,
      fileName,
      kind,
      expectedSize: expectedSize($(element).attr("data-size")),
    };
    const requestHeaders: Record<string, string> = {
      "User-Agent": browserDiscovery.userAgent,
    };
    if (isSameHostDocument && browserDiscovery.cookieHeader) {
      requestHeaders.Cookie = browserDiscovery.cookieHeader;
    }
    ephemeralAttachments.push({
      ...attachment,
      downloadUrl: url.toString(),
      requestHeaders,
    });
  });

  if (ephemeralAttachments.length === 0) {
    throw new AwAdapterError(
      "ADAPTER_FAILURE",
      false,
      "AW listing did not expose an allowlisted attachment",
      { stage: "manifest", type: "validation" },
    );
  }

  return {
    safeManifest: {
      consultationId: browserDiscovery.consultationId,
      selectedLots: browserDiscovery.selectedLots,
      attachments: ephemeralAttachments.map(
        ({ stableId, fileName, kind, expectedSize }) => ({
          stableId,
          fileName,
          kind,
          expectedSize,
        }),
      ),
    },
    ephemeralAttachments,
  };
}

export class AwSolutionsAdapter implements BuyerProfileAdapter {
  constructor(private readonly browserSession: AwBrowserSession) {}

  async discover(request: RecoveryRequest): Promise<AdapterDiscovery> {
    return parseAwListing(await this.browserSession.discover(request));
  }
}
