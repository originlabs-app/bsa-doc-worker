import { load } from "cheerio";

export type PortalName = "aw_solutions" | "place" | "maximilien";

export interface PortalConsultationCandidate {
  canonicalTitle: string;
  reference: string;
  buyerName: string;
  consultationUrl: string;
}

interface PortalResolutionHints {
  reference?: string | undefined;
  title?: string | undefined;
  buyerName?: string | undefined;
}

export type PortalSearchOutcome =
  | {
      type: "recoverable";
      portal: PortalName;
      canonicalTitle: string;
      consultationUrl: string;
    }
  | {
      type: "listed_external";
      portal: "aw_solutions";
      canonicalTitle: string;
      externalHost: string;
    }
  | { type: "not_found"; portal: PortalName };

const NON_DISTINCTIVE_TERMS = new Set([
  "batiments",
  "centre",
  "construction",
  "controles",
  "equipements",
  "extension",
  "groupe",
  "musee",
  "nouveau",
  "patrimoniale",
  "principal",
  "pour",
  "reglementaires",
  "renovation",
  "rempart",
  "rue",
  "secours",
  "scolaire",
  "travaux",
  "strasbourg",
]);

const MAX_SEARCH_RESPONSE_BYTES = 5 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 20_000;

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
}

function isHostOrSubdomain(hostname: string, root: string): boolean {
  return hostname === root || hostname.endsWith(`.${root}`);
}

export function resolveExactPortalConsultation(
  candidates: readonly PortalConsultationCandidate[],
  hints: PortalResolutionHints,
  rootHost: string,
): string {
  const safeCandidates = candidates.filter((candidate) => {
    try {
      const url = new URL(candidate.consultationUrl);
      return (
        url.protocol === "https:" &&
        isHostOrSubdomain(url.hostname.toLowerCase(), rootHost)
      );
    } catch {
      return false;
    }
  });

  const normalizedReference = normalize(hints.reference ?? "");
  const matches = normalizedReference
    ? safeCandidates.filter(
        (candidate) => normalize(candidate.reference) === normalizedReference,
      )
    : safeCandidates.filter((candidate) => {
        const normalizedTitle = normalize(hints.title ?? "");
        if (normalizedTitle.length < 20) return false;
        if (!normalize(candidate.canonicalTitle).startsWith(normalizedTitle)) {
          return false;
        }
        const normalizedBuyer = normalize(hints.buyerName ?? "");
        return (
          normalizedBuyer.length === 0 ||
          normalize(candidate.buyerName) === normalizedBuyer
        );
      });

  if (matches.length !== 1) {
    throw new Error("PORTAL_CONSULTATION_NOT_RESOLVED");
  }
  return matches[0]!.consultationUrl;
}

function isExactPrefix(candidateTitle: string, truncatedTitle: string): boolean {
  const candidate = normalize(candidateTitle);
  const target = normalize(truncatedTitle);
  return target.length >= 20 && candidate.startsWith(target);
}

function cleanText(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function safeHttpsUrl(rawUrl: string | undefined, baseUrl: string): URL | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, baseUrl);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isAwDceUrl(url: URL): boolean {
  const isAwHost =
    url.hostname === "marches-publics.info" ||
    url.hostname.endsWith(".marches-publics.info");
  return (
    isAwHost &&
    url.pathname.toLowerCase().endsWith("/mpiaws/index.cfm") &&
    (url.searchParams.get("fuseaction") ?? "").toLowerCase() ===
      "dematent.login" &&
    (url.searchParams.get("type") ?? "").toUpperCase() === "DCE" &&
    /^\d+$/.test(url.searchParams.get("IDM") ?? "")
  );
}

async function readBoundedHtml(response: Response): Promise<string> {
  if (!response.ok) throw new Error("PORTAL_SEARCH_HTTP_ERROR");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error("PORTAL_SEARCH_INVALID_CONTENT_TYPE");
  }
  if (!response.body) throw new Error("PORTAL_SEARCH_EMPTY_BODY");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let html = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_SEARCH_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("PORTAL_SEARCH_RESPONSE_TOO_LARGE");
    }
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

async function postPublicSearch(
  url: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if ([302, 303].includes(response.status)) {
    const redirectUrl = safeHttpsUrl(
      response.headers.get("location") ?? undefined,
      url,
    );
    if (!redirectUrl || redirectUrl.origin !== new URL(url).origin) {
      throw new Error("PORTAL_SEARCH_REDIRECT_BLOCKED");
    }
    response = await fetchImpl(redirectUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  }
  return readBoundedHtml(response);
}

function safeCookieHeader(response: Response): string {
  const cookies = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0] ?? "")
    .filter((value) =>
      /^[A-Za-z0-9!#$%&'*+.^_`|~-]+=[^;\r\n]{0,4096}$/.test(value),
    );
  const header = cookies.join("; ");
  return header.length <= 8_192 ? header : "";
}

function placeResultCount(html: string): number {
  const $ = load(html);
  const rawCount = cleanText(
    $("#ctl0_CONTENU_PAGE_resultSearch_nombreElement").first().text(),
  );
  const count = Number(rawCount);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

async function expandPlaceResults(
  html: string,
  cookieHeader: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const $ = load(html);
  const pageState = $("#PRADO_PAGESTATE").attr("value") ?? "";
  const action = $("form#ctl0_ctl1").attr("action");
  const actionUrl = safeHttpsUrl(action, "https://www.marches-publics.gouv.fr");
  if (
    !pageState ||
    pageState.length > MAX_SEARCH_RESPONSE_BYTES ||
    !actionUrl ||
    actionUrl.origin !== "https://www.marches-publics.gouv.fr"
  ) {
    throw new Error("PORTAL_SEARCH_EXPANSION_BLOCKED");
  }

  const body = new URLSearchParams({
    PRADO_PAGESTATE: pageState,
    "ctl0$CONTENU_PAGE$resultSearch$listePageSizeTop": "20",
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const response = await fetchImpl(actionUrl, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  return readBoundedHtml(response);
}

export function buildDistinctiveQuery(title: string): string {
  const tokens =
    title.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  const candidates = tokens
    .map((token, index) => ({ token, index, normalized: normalize(token) }))
    .filter(({ normalized }) => normalized.length >= 5)
    .filter(({ normalized }) => !NON_DISTINCTIVE_TERMS.has(normalized))
    .sort((left, right) =>
      right.normalized.length === left.normalized.length
        ? left.index - right.index
        : right.normalized.length - left.normalized.length,
    );
  if (candidates[0]) return candidates[0].token;

  const fallback = tokens
    .map((token, index) => ({ token, index, normalized: normalize(token) }))
    .filter(({ normalized }) => normalized.length >= 5)
    .sort((left, right) =>
      right.normalized.length === left.normalized.length
        ? left.index - right.index
        : right.normalized.length - left.normalized.length,
    )[0];
  return fallback?.token ?? title.trim();
}

export function parseAwPublicSearch(
  html: string,
  truncatedTitle: string,
): PortalSearchOutcome {
  const $ = load(html);
  for (const element of $("div.container-fluid#entity").toArray()) {
    const titleBox = $(element).find("#titre_box").first().clone();
    titleBox.find(".ref-acheteur, p").remove();
    const canonicalTitle = cleanText(titleBox.text());
    if (!isExactPrefix(canonicalTitle, truncatedTitle)) continue;

    const dceHref = $(element)
      .find("a[href]")
      .filter((_index, anchor) => {
        const label = cleanText($(anchor).text());
        const title = $(anchor).attr("title") ?? "";
        return label === "DCE" || /Dossier de Consultation/i.test(title);
      })
      .first()
      .attr("href");
    const dceUrl = safeHttpsUrl(
      dceHref,
      "https://www.marches-publics.info",
    );
    if (dceUrl && isAwDceUrl(dceUrl)) {
      return {
        type: "recoverable",
        portal: "aw_solutions",
        canonicalTitle,
        consultationUrl: dceUrl.toString(),
      };
    }

    const externalHref = $(element)
      .find("a[href]")
      .filter((_index, anchor) => {
        const label = cleanText($(anchor).text());
        const title = $(anchor).attr("title") ?? "";
        return label === "Déposer un pli" || /Candidature et\/ou Offre/i.test(title);
      })
      .first()
      .attr("href");
    const externalUrl = safeHttpsUrl(
      externalHref,
      "https://www.marches-publics.info",
    );
    if (externalUrl) {
      return {
        type: "listed_external",
        portal: "aw_solutions",
        canonicalTitle,
        externalHost: externalUrl.hostname,
      };
    }
  }
  return { type: "not_found", portal: "aw_solutions" };
}

export function parsePlacePublicSearch(
  html: string,
  truncatedTitle: string,
): PortalSearchOutcome {
  const $ = load(html);
  for (const element of $(".item_consultation").toArray()) {
    const canonicalTitle = cleanText(
      $(element)
        .find(".objet-line .truncate span[title]")
        .first()
        .attr("title") ?? "",
    );
    if (!isExactPrefix(canonicalTitle, truncatedTitle)) continue;

    const href = $(element)
      .find("a[href]")
      .filter((_index, anchor) =>
        cleanText($(anchor).text()).includes("Accéder à la consultation"),
      )
      .first()
      .attr("href");
    const consultationUrl = safeHttpsUrl(
      href,
      "https://www.marches-publics.gouv.fr",
    );
    if (
      consultationUrl?.hostname === "www.marches-publics.gouv.fr" &&
      /^\/app\.php\/entreprise\/consultation\/\d+$/.test(
        consultationUrl.pathname,
      )
    ) {
      return {
        type: "recoverable",
        portal: "place",
        canonicalTitle,
        consultationUrl: consultationUrl.toString(),
      };
    }
  }
  return { type: "not_found", portal: "place" };
}

export async function searchAwPublic(
  truncatedTitle: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PortalSearchOutcome> {
  const body = new URLSearchParams({
    IDE: "EC",
    IDN: "X",
    IDR: "X",
    txtLibre: buildDistinctiveQuery(truncatedTitle),
    Rechercher: "Rechercher",
  });
  const html = await postPublicSearch(
    "https://www.marches-publics.info/Annonces/lister",
    body,
    fetchImpl,
  );
  return parseAwPublicSearch(html, truncatedTitle);
}

export async function searchPlacePublic(
  truncatedTitle: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PortalSearchOutcome> {
  const body = new URLSearchParams({
    fromHomeSimpleSearch: "1",
    categorie: "0",
    keyWord: buildDistinctiveQuery(truncatedTitle),
  });
  const searchUrl =
    "https://www.marches-publics.gouv.fr/espace-entreprise/search";
  const firstResponse = await fetchImpl(searchUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (![302, 303].includes(firstResponse.status)) {
    const html = await readBoundedHtml(firstResponse);
    return parsePlacePublicSearch(html, truncatedTitle);
  }

  const redirectUrl = safeHttpsUrl(
    firstResponse.headers.get("location") ?? undefined,
    searchUrl,
  );
  if (
    !redirectUrl ||
    redirectUrl.origin !== "https://www.marches-publics.gouv.fr"
  ) {
    throw new Error("PORTAL_SEARCH_REDIRECT_BLOCKED");
  }
  const cookieHeader = safeCookieHeader(firstResponse);
  const secondResponse = await fetchImpl(redirectUrl, {
    method: "GET",
    ...(cookieHeader ? { headers: { Cookie: cookieHeader } } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  let html = await readBoundedHtml(secondResponse);
  const firstOutcome = parsePlacePublicSearch(html, truncatedTitle);
  if (firstOutcome.type === "recoverable") return firstOutcome;

  const resultCount = placeResultCount(html);
  if (resultCount <= 10) return firstOutcome;
  if (resultCount > 20) throw new Error("PORTAL_SEARCH_RESULT_CAP_REACHED");
  html = await expandPlaceResults(html, cookieHeader, fetchImpl);
  return parsePlacePublicSearch(html, truncatedTitle);
}
