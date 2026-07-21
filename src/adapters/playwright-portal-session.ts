import { chromium, type Browser, type Page } from "playwright-core";

import type { RecoveryRequest } from "../contracts.js";
import {
  resolveExactPortalConsultation,
  type PortalConsultationCandidate,
} from "../portal-resolver.js";
import { isAtexoDownloadActionUrl } from "./atexo.js";
import { PortalAdapterError } from "./portal-adapter-error.js";
import type {
  PortalBrowserDiscovery,
  PortalBrowserSession,
} from "./portal-manifest.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const USERNAME_SELECTOR =
  'input[type="email"], input[name*="mail" i], input[name*="login" i], input[name*="user" i], input[autocomplete="username"]';
const PASSWORD_SELECTOR = 'input[type="password"]';
const LOGIN_SUBMIT_SELECTOR =
  'button[type="submit"], input[type="submit"], button[name*="login" i]';
const AUTHENTICATION_ERROR_SELECTOR =
  '[role="alert"], .alert-danger, .error, .authentication-error';
const CAPTCHA_SELECTOR =
  'input[id*="captcha" i], input[name*="captcha" i], textarea[name*="captcha" i]';
const SEARCH_INPUT_SELECTOR =
  'input[type="search"], input[name*="search" i], input[name*="recherche" i], input[id*="search" i], input[id*="recherche" i]';
const SEARCH_SUBMIT_SELECTOR =
  'button[type="submit"], input[type="submit"], button[name*="search" i], button[name*="recherche" i]';

interface PortalCredentials {
  email: string;
  password: string;
}

export interface PlaywrightPortalSessionOptions extends PortalCredentials {
  browserlessToken: string;
  rootHost: string;
  displayName: string;
  timeoutMs?: number;
  solveCaptchas?: boolean;
}

function buildBrowserlessEndpoint(token: string, solveCaptchas: boolean): string {
  const endpoint = new URL("wss://production-ams.browserless.io/stealth");
  endpoint.searchParams.set("token", token);
  endpoint.searchParams.set("solveCaptchas", String(solveCaptchas));
  return endpoint.toString();
}

function isHostOrSubdomain(hostname: string, root: string): boolean {
  return hostname === root || hostname.endsWith(`.${root}`);
}

async function waitForOptionalNavigation(
  page: Page,
  action: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: timeoutMs })
      .catch(() => null),
    action(),
  ]);
}

export function extractPortalConsultationId(
  rawUrl: string,
  rootHost: string,
): string {
  const url = new URL(rawUrl);
  if (!isHostOrSubdomain(url.hostname.toLowerCase(), rootHost)) {
    throw new PortalAdapterError(
      "PROFILE_LINK_NOT_FINAL",
      false,
      "Portal consultation URL is not final",
    );
  }
  for (const [key, value] of url.searchParams) {
    if (/^(id|idconsultation|consultationid)$/i.test(key) && /^\d+$/.test(value)) {
      return value;
    }
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const consultationIndex = segments.findIndex((segment) =>
    /^consultation$/i.test(segment),
  );
  const candidate =
    consultationIndex >= 0 ? segments[consultationIndex + 1] : undefined;
  if (candidate && /^\d+$/.test(candidate)) return candidate;
  throw new PortalAdapterError(
    "PROFILE_LINK_NOT_FINAL",
    false,
    "Portal consultation URL is not final",
  );
}

export async function authenticatePortalIfPrompted(
  page: Page,
  credentials: PortalCredentials,
  displayName: string,
  timeoutMs: number,
): Promise<boolean> {
  const username = page.locator(USERNAME_SELECTOR).first();
  const password = page.locator(PASSWORD_SELECTOR).first();
  const usernameVisible = await username.isVisible().catch(() => false);
  const passwordVisible = await password.isVisible().catch(() => false);
  if (!usernameVisible && !passwordVisible) return false;
  if (!usernameVisible || !passwordVisible) {
    throw new PortalAdapterError(
      "PORTAL_DISCOVERY_BLOCKED",
      false,
      `${displayName} login form is incomplete`,
    );
  }

  await username.fill(credentials.email);
  await password.fill(credentials.password);
  const submit = page.locator(LOGIN_SUBMIT_SELECTOR).first();
  if ((await submit.count()) === 0) {
    throw new PortalAdapterError(
      "PORTAL_DISCOVERY_BLOCKED",
      false,
      `${displayName} login submit control is unavailable`,
    );
  }
  await waitForOptionalNavigation(page, () => submit.click(), timeoutMs);

  const authenticationError = page
    .locator(AUTHENTICATION_ERROR_SELECTOR)
    .first();
  if (await authenticationError.isVisible().catch(() => false)) {
    throw new PortalAdapterError(
      "PORTAL_AUTHENTICATION_REJECTED",
      false,
      `${displayName} authentication was rejected`,
    );
  }
  return true;
}

export async function ensureCaptchaSolved(
  page: Page,
  timeoutMs: number,
  displayName: string,
): Promise<void> {
  const captchaField = page.locator(CAPTCHA_SELECTOR).first();
  if ((await captchaField.count()) === 0) return;
  if (!(await captchaField.isVisible().catch(() => false))) return;
  try {
    await page.waitForFunction(
      (selector) => {
        const field = document.querySelector<
          HTMLInputElement | HTMLTextAreaElement
        >(selector);
        return !field || field.value.trim().length > 0;
      },
      CAPTCHA_SELECTOR,
      { timeout: timeoutMs },
    );
  } catch {
    throw new PortalAdapterError(
      "CAPTCHA_UNSOLVED",
      true,
      `Browserless did not solve the ${displayName} CAPTCHA in time`,
    );
  }
}

async function collectConsultationCandidates(
  page: Page,
): Promise<PortalConsultationCandidate[]> {
  return page.locator("a[href]").evaluateAll((elements) =>
    elements.map((element) => {
      const anchor = element as HTMLAnchorElement;
      const container =
        anchor.closest<HTMLElement>(
          "[data-reference], .consultation, .result, .search-result, tr, li, article",
        ) ?? anchor.parentElement;
      const text = (value: string | null | undefined) => value?.trim() ?? "";
      const titleElement = container?.querySelector<HTMLElement>(
        "[data-title], .title, .objet, .consultation-title",
      );
      const referenceElement = container?.querySelector<HTMLElement>(
        "[data-reference], .reference, .ref",
      );
      const buyerElement = container?.querySelector<HTMLElement>(
        "[data-buyer], .buyer, .acheteur",
      );
      return {
        canonicalTitle: text(
          anchor.title ||
            titleElement?.dataset.title ||
            titleElement?.textContent ||
            anchor.textContent,
        ),
        reference: text(
          container?.dataset.reference ||
            referenceElement?.dataset.reference ||
            referenceElement?.textContent,
        ),
        buyerName: text(
          container?.dataset.buyer ||
            buyerElement?.dataset.buyer ||
            buyerElement?.textContent,
        ),
        consultationUrl: anchor.href,
      };
    }),
  );
}

async function resolveConsultationUrl(
  page: Page,
  request: RecoveryRequest,
  options: PlaywrightPortalSessionOptions,
  timeoutMs: number,
): Promise<string> {
  try {
    extractPortalConsultationId(request.providedUrl, options.rootHost);
    return request.providedUrl;
  } catch (error) {
    if (!(error instanceof PortalAdapterError)) throw error;
  }

  const query =
    request.searchHints?.reference?.trim() ||
    request.searchHints?.title?.trim();
  if (!query) {
    throw new PortalAdapterError(
      "PROFILE_LINK_NOT_FINAL",
      false,
      `${options.displayName} consultation search hints are unavailable`,
    );
  }
  const searchInput = page.locator(SEARCH_INPUT_SELECTOR).first();
  if (!(await searchInput.isVisible().catch(() => false))) {
    await searchInput
      .waitFor({ state: "visible", timeout: timeoutMs })
      .catch(() => undefined);
  }
  if (!(await searchInput.isVisible().catch(() => false))) {
    throw new PortalAdapterError(
      "PROFILE_LINK_NOT_FINAL",
      false,
      `${options.displayName} consultation search is unavailable`,
    );
  }
  await searchInput.fill(query);
  const searchSubmit = page.locator(SEARCH_SUBMIT_SELECTOR).first();
  if ((await searchSubmit.count()) === 0) {
    throw new PortalAdapterError(
      "PROFILE_LINK_NOT_FINAL",
      false,
      `${options.displayName} search submit control is unavailable`,
    );
  }
  await waitForOptionalNavigation(page, () => searchSubmit.click(), timeoutMs);

  try {
    return resolveExactPortalConsultation(
      await collectConsultationCandidates(page),
      request.searchHints ?? {},
      options.rootHost,
    );
  } catch {
    throw new PortalAdapterError(
      "PROFILE_LINK_NOT_FINAL",
      false,
      `${options.displayName} consultation was not resolved exactly`,
    );
  }
}

async function selectRequestedLots(
  page: Page,
  request: RecoveryRequest,
  displayName: string,
): Promise<void> {
  if (request.requestedLots.kind === "all") return;
  const selected = await page
    .locator('input[type="checkbox"]')
    .evaluateAll((elements, lotIds) => {
      let count = 0;
      for (const element of elements) {
        const input = element as HTMLInputElement;
        if (lotIds.includes(input.value)) {
          input.click();
          count += 1;
        }
      }
      return count;
    }, request.requestedLots.ids);
  if (selected !== request.requestedLots.ids.length) {
    throw new PortalAdapterError(
      "PORTAL_DISCOVERY_BLOCKED",
      false,
      `One or more requested ${displayName} lots are unavailable`,
    );
  }
}

export function isSafeManifestControlTarget(
  rawTarget: string | null,
  currentPageUrl: string,
  rootHost: string,
): boolean {
  if (!rawTarget) return true;
  try {
    const target = new URL(rawTarget, currentPageUrl);
    if (
      target.protocol !== "https:" ||
      !isHostOrSubdomain(target.hostname.toLowerCase(), rootHost)
    ) {
      return false;
    }
    const attachmentPath =
      /\/(?:download|attachment|t[eé]l[eé]charg(?:ement)?)\b/i.test(
        target.pathname,
      ) ||
      /\/dce\/(?:document|pi[eè]ce)\b/i.test(target.pathname) ||
      /\.(?:pdf|zip)$/i.test(target.pathname);
    const attachmentAction =
      (target.searchParams.get("fuseaction") ?? "").toLowerCase() ===
        "dce.tdoc" ||
      target.searchParams.has("download") ||
      isAtexoDownloadActionUrl(target);
    return !attachmentPath && !attachmentAction;
  } catch {
    return false;
  }
}

async function revealManifest(
  page: Page,
  timeoutMs: number,
  rootHost: string,
): Promise<void> {
  const controls = page
    .locator('button, [role="button"], a[href]')
    .filter({
      hasText:
        /DCE|documents? de la consultation|pi[eè]ces? de la consultation|dossier de consultation/i,
    });
  const count = Math.min(await controls.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const target =
      (await control.getAttribute("href")) ??
      (await control.getAttribute("formaction")) ??
      (await control.evaluate((element) => {
        if (!(element instanceof HTMLButtonElement)) return null;
        return element.form?.action || null;
      }));
    if (!isSafeManifestControlTarget(target, page.url(), rootHost)) continue;
    await waitForOptionalNavigation(page, () => control.click(), timeoutMs);
    return;
  }
}

export class PlaywrightPortalBrowserSession implements PortalBrowserSession {
  private readonly timeoutMs: number;

  constructor(private readonly options: PlaywrightPortalSessionOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async discover(request: RecoveryRequest): Promise<PortalBrowserDiscovery> {
    let browser: Browser | undefined;
    try {
      const providedUrl = new URL(request.providedUrl);
      if (
        !isHostOrSubdomain(
          providedUrl.hostname.toLowerCase(),
          this.options.rootHost,
        )
      ) {
        throw new PortalAdapterError(
          "PROFILE_LINK_NOT_FINAL",
          false,
          `${this.options.displayName} URL is outside the allowlist`,
        );
      }

      browser = await chromium.connectOverCDP(
        buildBrowserlessEndpoint(
          this.options.browserlessToken,
          this.options.solveCaptchas ?? true,
        ),
        { timeout: this.timeoutMs },
      );
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(request.providedUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      const authenticated = await authenticatePortalIfPrompted(
        page,
        this.options,
        this.options.displayName,
        this.timeoutMs,
      );
      await ensureCaptchaSolved(
        page,
        this.timeoutMs,
        this.options.displayName,
      );

      const consultationUrl = await resolveConsultationUrl(
        page,
        request,
        this.options,
        this.timeoutMs,
      );
      if (consultationUrl !== request.providedUrl || authenticated) {
        await page.goto(consultationUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.timeoutMs,
        });
        await authenticatePortalIfPrompted(
          page,
          this.options,
          this.options.displayName,
          this.timeoutMs,
        );
      }
      await ensureCaptchaSolved(
        page,
        this.timeoutMs,
        this.options.displayName,
      );
      await selectRequestedLots(page, request, this.options.displayName);
      await revealManifest(page, this.timeoutMs, this.options.rootHost);
      await ensureCaptchaSolved(
        page,
        this.timeoutMs,
        this.options.displayName,
      );

      const sourceUrl = new URL(page.url());
      if (
        sourceUrl.protocol !== "https:" ||
        !isHostOrSubdomain(
          sourceUrl.hostname.toLowerCase(),
          this.options.rootHost,
        )
      ) {
        throw new PortalAdapterError(
          "PORTAL_DISCOVERY_BLOCKED",
          false,
          `${this.options.displayName} manifest left the allowlisted portal`,
        );
      }
      const cookies = await context.cookies([sourceUrl.origin]);
      return {
        consultationUrl: sourceUrl.toString(),
        consultationId: extractPortalConsultationId(
          consultationUrl,
          this.options.rootHost,
        ),
        selectedLots:
          request.requestedLots.kind === "all"
            ? ["all"]
            : [...request.requestedLots.ids],
        listingHtml: await page.content(),
        cookieHeader: cookies
          .map(({ name, value }) => `${name}=${value}`)
          .join("; "),
        userAgent: await page.evaluate(() => navigator.userAgent),
      };
    } catch (error) {
      if (error instanceof PortalAdapterError) throw error;
      throw new PortalAdapterError(
        "PORTAL_DISCOVERY_BLOCKED",
        true,
        `Browserless ${this.options.displayName} discovery failed`,
      );
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }
}
