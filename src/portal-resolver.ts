import { load } from "cheerio";

export type PortalName = "aw_solutions" | "place" | "maximilien";

export interface PortalConsultationCandidate {
  canonicalTitle: string;
  reference: string;
  buyerName: string;
  consultationUrl: string;
  lotTitles?: string[];
  deadlineAt?: string;
  recoveryDisposition?: "recoverable" | "external_blocked";
  blockedExternalHost?: string;
  lotDetailUrl?: string;
}

export interface PortalPublicCandidateResult {
  candidates: PortalConsultationCandidate[];
  blockedExternalHosts: string[];
  requestCount?: number;
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
  "agrandissement",
  "amenagement",
  "batiments",
  "centre",
  "construction",
  "controles",
  "decheterie",
  "equipements",
  "extension",
  "gardien",
  "groupe",
  "local",
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
const MAX_PORTAL_REQUESTS = 8;
const MAX_SEARCH_QUERIES = 4;

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

function withoutLabel(value: string, label: RegExp): string {
  return cleanText(value).replace(label, "").trim();
}

function withoutPostalSuffix(value: string): string {
  return cleanText(value).replace(/\s*\(\s*\d{5}\b[^)]*\)\s*$/, "").trim();
}

function cleanReference(value: string): string {
  const cleaned = cleanText(value).replace(/^\[|\]$/g, "").trim();
  return cleaned
    .replace(/^(?:réf(?:érence)?|ref(?:erence)?)(?:\s+acheteur)?\s*[.:]?\s*/i, "")
    .replace(/\]$/, "")
    .trim();
}

function parisLocalToIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcGuess));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const represented = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
  );
  return new Date(utcGuess - (represented - utcGuess)).toISOString();
}

function parseFrenchDeadline(value: string): string | undefined {
  const match = cleanText(value).match(
    /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b[^\d]{0,20}(\d{1,2})(?::|h)(\d{2})\b/i,
  );
  if (!match) return undefined;
  const shortYear = Number(match[3]);
  const year = shortYear < 100 ? 2000 + shortYear : shortYear;
  const month = Number(match[2]);
  const day = Number(match[1]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) return undefined;
  return parisLocalToIso(year, month, day, hour, minute);
}

function parseAtexoDeadlineParts(
  dayValue: string,
  monthValue: string,
  yearValue: string,
  timeValue: string,
): string | undefined {
  const months: Record<string, number> = {
    janv: 1,
    fevr: 2,
    mars: 3,
    avr: 4,
    mai: 5,
    juin: 6,
    juil: 7,
    aout: 8,
    sept: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const day = Number(cleanText(dayValue));
  const month = months[normalize(monthValue).replaceAll(" ", "")];
  const year = Number(cleanText(yearValue));
  const time = cleanText(timeValue).match(/(\d{1,2}):([0-5]\d)/);
  if (!month || !time || day < 1 || day > 31 || year < 2000) return undefined;
  return parisLocalToIso(year, month, day, Number(time[1]), Number(time[2]));
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
  return (
    url.origin === "https://www.marches-publics.info" &&
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
  const budget = { count: 0 };
  return boundedHtmlRequest(
    new URL(url),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    new URL(url).origin,
    budget,
    fetchImpl,
  );
}

interface RequestBudget {
  count: number;
}

async function boundedHtmlRequest(
  url: URL,
  init: RequestInit,
  expectedOrigin: string,
  budget: RequestBudget,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (url.protocol !== "https:" || url.origin !== expectedOrigin) {
    throw new Error("PORTAL_SEARCH_URL_BLOCKED");
  }
  if (budget.count >= MAX_PORTAL_REQUESTS) {
    throw new Error("PORTAL_SEARCH_REQUEST_LIMIT");
  }
  budget.count += 1;
  const response = await fetchImpl(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const redirectUrl = safeHttpsUrl(
      response.headers.get("location") ?? undefined,
      url.toString(),
    );
    if (!redirectUrl || redirectUrl.origin !== expectedOrigin) {
      throw new Error("PORTAL_SEARCH_REDIRECT_BLOCKED");
    }
    return boundedHtmlRequest(
      redirectUrl,
      { method: "GET" },
      expectedOrigin,
      budget,
      fetchImpl,
    );
  }
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

export function parseAwPublicCandidates(
  html: string,
): PortalPublicCandidateResult {
  const $ = load(html);
  const candidates: PortalConsultationCandidate[] = [];
  const blockedExternalHosts = new Set<string>();
  for (const element of $("div.container-fluid#entity").toArray()) {
    const titleBox = $(element).find("#titre_box").first().clone();
    titleBox.find(".ref-acheteur, p").remove();
    const canonicalTitle = cleanText(titleBox.text());
    const reference = cleanReference(
      $(element).find(".ref-acheteur, [class*='reference']").first().text(),
    );
    const headingBuyer = withoutPostalSuffix(
      $(element).find("h2.h2-avis").first().text(),
    );
    const labelledBuyer = $(element)
      .find(".acheteur:not(.ref-acheteur), .buyer, p")
      .filter((_index, candidate) =>
        /^(?:acheteur|buyer)\s*:/i.test(cleanText($(candidate).text())),
      )
      .first()
      .text();
    const buyerName = headingBuyer || withoutLabel(
      labelledBuyer,
      /^(?:acheteur|buyer)\s*:\s*/i,
    );
    const deadlineAt = parseFrenchDeadline($(element).text());
    let dceUrl: URL | null = null;
    let noticeUrl: URL | null = null;
    let blockedExternalHost: string | undefined;

    for (const anchor of $(element).find("a[href]").toArray()) {
      const label = cleanText($(anchor).text());
      const title = $(anchor).attr("title") ?? "";
      const url = safeHttpsUrl(
        $(anchor).attr("href"),
        "https://www.marches-publics.info",
      );
      if (!url) continue;
      if (
        (label === "DCE" || /Dossier de Consultation/i.test(title)) &&
        isAwDceUrl(url)
      ) {
        dceUrl = url;
      } else if (
        (label === "Déposer un pli" || /Candidature et\/ou Offre/i.test(title)) &&
        !isHostOrSubdomain(url.hostname.toLowerCase(), "marches-publics.info")
      ) {
        blockedExternalHost = url.hostname.toLowerCase();
        blockedExternalHosts.add(blockedExternalHost);
      } else if (
        url.origin === "https://www.marches-publics.info" &&
        /^\/Annonces\/MPI-pub-\d+\.htm$/i.test(url.pathname)
      ) {
        noticeUrl = url;
      }
    }

    if (!canonicalTitle) continue;
    if (dceUrl) {
      candidates.push({
        canonicalTitle,
        reference,
        buyerName,
        consultationUrl: dceUrl.toString(),
        lotTitles: [],
        ...(deadlineAt ? { deadlineAt } : {}),
        recoveryDisposition: "recoverable",
      });
    } else if (noticeUrl && blockedExternalHost) {
      candidates.push({
        canonicalTitle,
        reference,
        buyerName,
        consultationUrl: noticeUrl.toString(),
        lotTitles: [],
        ...(deadlineAt ? { deadlineAt } : {}),
        recoveryDisposition: "external_blocked",
        blockedExternalHost,
      });
    }
  }
  return {
    candidates: candidates.slice(0, 100),
    blockedExternalHosts: [...blockedExternalHosts].sort(),
  };
}

function atexoOrigin(portal: "place" | "maximilien"): string {
  return portal === "place"
    ? "https://www.marches-publics.gouv.fr"
    : "https://marches.maximilien.fr";
}

function isAtexoConsultationUrl(
  url: URL,
  portal: "place" | "maximilien",
): boolean {
  if (url.origin !== atexoOrigin(portal)) return false;
  if (/^\/app\.php\/entreprise\/consultation\/\d+$/.test(url.pathname)) {
    return true;
  }
  if (/^\/entreprise\/consultation\/\d+$/.test(url.pathname)) return true;
  return (
    url.pathname.toLowerCase().endsWith("/index.php") &&
    (url.searchParams.get("page") ?? "") ===
      "Entreprise.EntrepriseDetailsConsultation" &&
    /^\d+$/.test(url.searchParams.get("id") ?? "")
  );
}

export function parseAtexoPublicCandidates(
  html: string,
  portal: "place" | "maximilien",
): PortalPublicCandidateResult {
  const $ = load(html);
  const candidates: PortalConsultationCandidate[] = [];
  for (const element of $(".item_consultation").toArray()) {
    const canonicalTitle = cleanText(
      $(element).find(".objet-line .truncate span[title]").first().attr("title") ??
        $(element).find(".objet-line span[title]").first().attr("title") ??
        $(element).find(".objet-line").first().text(),
    );
    const reference = cleanReference(
      $(element)
        .find(".objet-line .m-b-1 .small.pull-left, .reference, [class*='reference']")
        .first()
        .text(),
    );
    const buyerNode = $(element)
      .find(
        "[id$='panelBlocDenomination'] .truncate-700[title], .panelBlocDenomination .truncate-700[title], .acheteur, [class*='acheteur'], [class*='organisme']",
      )
      .first();
    const buyerName = withoutPostalSuffix(withoutLabel(
      buyerNode.attr("title") ?? buyerNode.text(),
      /^(?:acheteur|organisme)\s*:\s*/i,
    ));
    const deadlineNode = $(element).find(".cons_dateEnd").first();
    const deadlineAt = parseAtexoDeadlineParts(
      deadlineNode.find(".day").first().text(),
      deadlineNode.find(".month").first().text(),
      deadlineNode.find(".year").first().text(),
      deadlineNode.find(".time").first().text(),
    ) ?? parseFrenchDeadline(deadlineNode.text());
    const href = $(element)
      .find("a[href]")
      .filter((_index, anchor) =>
        /Accéder à la consultation/i.test(cleanText($(anchor).text())),
      )
      .first()
      .attr("href");
    const consultationUrl = safeHttpsUrl(href, atexoOrigin(portal));
    const lotAnchor = $(element)
      .find("a[href*='Entreprise.PopUpDetailLots']")
      .first()
      .attr("href");
    const lotPath = lotAnchor?.match(
      /['"]([^'"]*page=Entreprise\.PopUpDetailLots[^'"]*)['"]/,
    )?.[1] ?? lotAnchor;
    const lotDetailUrl = safeHttpsUrl(lotPath, atexoOrigin(portal));
    const safeLotDetailUrl =
      lotDetailUrl?.origin === atexoOrigin(portal) &&
      lotDetailUrl.searchParams.get("page") === "Entreprise.PopUpDetailLots" &&
      /^\d+$/.test(lotDetailUrl.searchParams.get("id") ?? "")
        ? lotDetailUrl.toString()
        : undefined;
    if (
      canonicalTitle &&
      consultationUrl &&
      isAtexoConsultationUrl(consultationUrl, portal)
    ) {
      candidates.push({
        canonicalTitle,
        reference,
        buyerName,
        consultationUrl: consultationUrl.toString(),
        lotTitles: [],
        ...(deadlineAt ? { deadlineAt } : {}),
        recoveryDisposition: "recoverable",
        ...(safeLotDetailUrl ? { lotDetailUrl: safeLotDetailUrl } : {}),
      });
    }
  }
  return { candidates: candidates.slice(0, 100), blockedExternalHosts: [] };
}

function atexoSearchUrl(
  portal: "place" | "maximilien",
  query: string,
): URL {
  const origin = atexoOrigin(portal);
  const url = new URL("/", origin);
  url.searchParams.set("page", "Entreprise.EntrepriseAdvancedSearch");
  url.searchParams.set("searchAnnCons", "");
  url.searchParams.set("keyWord", query);
  return url;
}

function parseAtexoLotTitles(html: string): string[] {
  const $ = load(html);
  const titles = new Set<string>();
  for (const heading of $(".panel-heading").toArray()) {
    const titled = cleanText($(heading).find("[title]").last().attr("title") ?? "");
    const text = cleanText($(heading).text()).replace(
      /^Lot\s+(?:n[°o]?\s*)?\d+\s*:\s*/i,
      "",
    );
    const title = titled || text;
    if (title) titles.add(title);
  }
  return [...titles];
}

function boundedQueries(queries: readonly string[] | string): string[] {
  const values = typeof queries === "string" ? [queries] : queries;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const query = cleanText(value);
    const key = normalize(query);
    if (!query || seen.has(key)) continue;
    seen.add(key);
    result.push(query);
    if (result.length === MAX_SEARCH_QUERIES) break;
  }
  return result;
}

export async function searchPortalPublicCandidates(
  portal: PortalName,
  queries: readonly string[] | string,
  fetchImpl: typeof fetch = fetch,
): Promise<PortalPublicCandidateResult> {
  const budget = { count: 0 };
  const candidates: PortalConsultationCandidate[] = [];
  const blockedExternalHosts = new Set<string>();
  for (const query of boundedQueries(queries)) {
    let parsed: PortalPublicCandidateResult;
    if (portal === "aw_solutions") {
      const origin = "https://www.marches-publics.info";
      const html = await boundedHtmlRequest(
        new URL("/Annonces/lister", origin),
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            IDE: "EC",
            IDN: "X",
            IDR: "X",
            txtLibre: query,
            Rechercher: "Rechercher",
          }),
        },
        origin,
        budget,
        fetchImpl,
      );
      parsed = parseAwPublicCandidates(html);
    } else {
      const origin = atexoOrigin(portal);
      const html = await boundedHtmlRequest(
        atexoSearchUrl(portal, query),
        { method: "GET" },
        origin,
        budget,
        fetchImpl,
      );
      parsed = parseAtexoPublicCandidates(html, portal);
    }
    candidates.push(...parsed.candidates);
    for (const host of parsed.blockedExternalHosts) {
      blockedExternalHosts.add(host);
    }
    if (parsed.candidates.length > 0) break;
  }

  if (portal !== "aw_solutions") {
    const origin = atexoOrigin(portal);
    for (const candidate of candidates) {
      if (!candidate.lotDetailUrl || budget.count >= MAX_PORTAL_REQUESTS) break;
      const html = await boundedHtmlRequest(
        new URL(candidate.lotDetailUrl),
        { method: "GET" },
        origin,
        budget,
        fetchImpl,
      );
      candidate.lotTitles = parseAtexoLotTitles(html);
    }
  }

  const deduplicated = [
    ...new Map(
      candidates.map((candidate) => [candidate.consultationUrl, candidate]),
    ).values(),
  ].slice(0, 100);
  return {
    candidates: deduplicated,
    blockedExternalHosts: [...blockedExternalHosts].sort(),
    requestCount: budget.count,
  };
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
  const origin = "https://www.marches-publics.gouv.fr";
  const budget = { count: 0 };
  const html = await boundedHtmlRequest(
    atexoSearchUrl("place", buildDistinctiveQuery(truncatedTitle)),
    { method: "GET" },
    origin,
    budget,
    fetchImpl,
  );
  return parsePlacePublicSearch(html, truncatedTitle);
}
