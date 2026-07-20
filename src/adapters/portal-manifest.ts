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
import { atexoPageAction, isAtexoDownloadActionUrl } from "./atexo.js";
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
  const material = [
    platform,
    consultationId,
    url.hostname,
    url.pathname,
    fileName,
  ];
  // Atexo download URLs share the same `/index.php` pathname; their identity
  // lives in the stable, non-secret query action (and target id when present).
  const atexoAction = atexoPageAction(url);
  if (atexoAction !== null) {
    material.push(atexoAction.toLowerCase());
    const atexoTargetId = url.searchParams.get("id");
    if (atexoTargetId) material.push(atexoTargetId);
  }
  return createHash("sha256")
    .update(material.join("|"))
    .digest("hex")
    .slice(0, 24);
}

function isAttachmentUrl(url: URL, rootHost: string): boolean {
  if (url.protocol !== "https:" || !isHostOrSubdomain(url.hostname, rootHost)) {
    return false;
  }
  return (
    /(dce|document|pi[eè]ce|attachment|download|t[eé]l[eé]charg)/i.test(
      url.pathname,
    ) || isAtexoDownloadActionUrl(url)
  );
}

// Action links rendered next to the pieces ("Signer un document", signature
// pages) are portal features, never downloadable pieces. The night sweep of
// 2026-07-20 saw exactly this false positive on Maximilien consultation
// 942952, where the frozen manifest contained "Signer un document".
const NON_ATTACHMENT_ACTION_LABEL_PATTERN = /^\s*sign(?:er|ature)\b/i;
const SIGNATURE_ACTION_URL_PATTERN =
  /(?:^|[/._-])sign(?:er|ature)s?(?=$|[/._-])/i;

function isNonAttachmentActionLink(label: string, url: URL): boolean {
  if (NON_ATTACHMENT_ACTION_LABEL_PATTERN.test(label)) return true;
  const atexoAction = atexoPageAction(url);
  if (atexoAction !== null && /sign(?:er|ature)/i.test(atexoAction)) {
    return true;
  }
  return SIGNATURE_ACTION_URL_PATTERN.test(url.pathname);
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

    const anchorText = $(element).text().trim();
    if (isNonAttachmentActionLink(anchorText, url)) return;

    const pathName =
      url.pathname.split("/").filter(Boolean).at(-1) ?? "attachment";
    const fileName = sanitizeFileName(
      $(element).attr("download")?.trim() ||
        $(element).attr("data-file-name")?.trim() ||
        $(element).attr("data-filename")?.trim() ||
        anchorText ||
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
