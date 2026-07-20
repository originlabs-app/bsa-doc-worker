import { createHash } from "node:crypto";

import { load } from "cheerio";

import type {
  AdapterPlatform,
  RecoveryRequest,
  SafeManifestAttachment,
} from "../contracts.js";
import type {
  AdapterDiscovery,
  EphemeralAttachment,
} from "../ports.js";
import { PortalAdapterError } from "./portal-adapter-error.js";

export interface PortalBrowserDiscovery {
  consultationUrl: string;
  consultationId: string;
  selectedLots: string[];
  listingHtml: string;
  cookieHeader: string;
  userAgent: string;
}

export interface PortalBrowserSession {
  discover(request: RecoveryRequest): Promise<PortalBrowserDiscovery>;
}

interface PortalManifestOptions {
  platform: Exclude<AdapterPlatform, "aw_solutions">;
  rootHost: string;
  displayName: string;
}

function isHostOrSubdomain(hostname: string, root: string): boolean {
  return hostname === root || hostname.endsWith(`.${root}`);
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

function expectedSize(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function inferKind(fileName: string) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf" as const;
  if (lower.endsWith(".zip")) return "zip" as const;
  return "unknown" as const;
}

function stableAttachmentId(
  platform: PortalManifestOptions["platform"],
  consultationId: string,
  url: URL,
  fileName: string,
): string {
  return createHash("sha256")
    .update(
      [platform, consultationId, url.hostname, url.pathname, fileName].join(
        "|",
      ),
    )
    .digest("hex")
    .slice(0, 24);
}

function isAttachmentUrl(url: URL, rootHost: string): boolean {
  return (
    url.protocol === "https:" &&
    isHostOrSubdomain(url.hostname, rootHost) &&
    /(dce|document|pi[eè]ce|attachment|download|t[eé]l[eé]charg)/i.test(
      url.pathname,
    )
  );
}

export function parsePortalListing(
  discovery: PortalBrowserDiscovery,
  options: PortalManifestOptions,
): AdapterDiscovery {
  const sourceUrl = new URL(discovery.consultationUrl);
  if (!isHostOrSubdomain(sourceUrl.hostname, options.rootHost)) {
    throw new PortalAdapterError(
      "PORTAL_DISCOVERY_BLOCKED",
      false,
      `${options.displayName} consultation host is not allowlisted`,
    );
  }

  const $ = load(discovery.listingHtml);
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
    if (!isAttachmentUrl(url, options.rootHost)) return;

    const pathName =
      url.pathname.split("/").filter(Boolean).at(-1) ?? "attachment";
    const fileName = sanitizeFileName(
      $(element).attr("download")?.trim() ||
        $(element).attr("data-file-name")?.trim() ||
        $(element).attr("data-filename")?.trim() ||
        $(element).text().trim() ||
        pathName,
      "attachment",
    );
    const stableId = stableAttachmentId(
      options.platform,
      discovery.consultationId,
      url,
      fileName,
    );
    if (seen.has(stableId)) return;
    seen.add(stableId);

    const attachment: SafeManifestAttachment = {
      stableId,
      fileName,
      kind: inferKind(fileName),
      expectedSize: expectedSize($(element).attr("data-size")),
    };
    const requestHeaders: Record<string, string> = {
      "User-Agent": discovery.userAgent,
    };
    if (
      url.hostname === sourceUrl.hostname &&
      discovery.cookieHeader.length > 0
    ) {
      requestHeaders.Cookie = discovery.cookieHeader;
    }
    ephemeralAttachments.push({
      ...attachment,
      sourcePlatform: options.platform,
      downloadUrl: url.toString(),
      requestHeaders,
    });
  });

  if (ephemeralAttachments.length === 0) {
    throw new PortalAdapterError(
      "PORTAL_DISCOVERY_BLOCKED",
      false,
      `${options.displayName} manifest did not expose an allowlisted attachment`,
    );
  }

  return {
    safeManifest: {
      consultationId: discovery.consultationId,
      selectedLots: discovery.selectedLots,
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
