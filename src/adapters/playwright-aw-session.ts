import {
  chromium,
  type Browser,
  type Locator,
  type Page,
} from "playwright-core";

import type { RecoveryRequest } from "../contracts.js";
import {
  AwAdapterError,
  type AwBrowserDiscovery,
  type AwBrowserSession,
} from "./aw-solutions.js";

const DEFAULT_TIMEOUT_MS = 45_000;

// Browserless bills a CAPTCHA solve at 10 units. Each portal attempt funds at
// most one solve; the worker's two-attempt cap bounds a tender at 20 units.
export const AW_CAPTCHA_SOLVE_UNIT_COST = 10;
export const AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_ATTEMPT = 10;

export class AwCaptchaSolveBudget {
  private committedUnits = 0;

  get unitsCommitted(): number {
    return this.committedUnits;
  }

  commitSolve(): void {
    if (
      this.committedUnits + AW_CAPTCHA_SOLVE_UNIT_COST >
      AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_ATTEMPT
    ) {
      throw new AwAdapterError(
        "CAPTCHA_UNSOLVED",
        true,
        "AW CAPTCHA solve budget for this attempt is exhausted",
      );
    }
    this.committedUnits += AW_CAPTCHA_SOLVE_UNIT_COST;
  }
}

// AW `dematEnt.choixDCE` wall (night sweep 2026-07-20): no anonymous
// withdrawal button, a CAPTCHA, and an identification appeal behind a link
// ("POUR RETIRER UN DCE, VOUS DEVEZ VOUS IDENTIFIER") that must be clicked
// before the proven Keycloak form appears.
const CHOIX_DCE_IDENTIFICATION_PATTERN =
  /VOUS\s+DEVEZ\s+VOUS\s+IDENTIFIER|S['’]IDENTIFIER/i;
const DCE_COMPLET_PATTERN = /DCE\s+COMPLET/i;
const VALIDATE_PATTERN = /^\s*VALIDER\s*$/i;

export interface PlaywrightAwSessionOptions {
  browserlessToken: string;
  awPortalEmail: string;
  awPortalPassword: string;
  timeoutMs?: number;
  captchaBudget?: AwCaptchaSolveBudget;
}

function buildBrowserlessEndpoint(token: string): string {
  const endpoint = new URL("wss://production-ams.browserless.io/stealth");
  endpoint.searchParams.set("token", token);
  endpoint.searchParams.set("solveCaptchas", "true");
  return endpoint.toString();
}

function extractConsultationId(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === "idm" && value) return value;
  }
  throw new AwAdapterError(
    "PROFILE_LINK_NOT_FINAL",
    false,
    "AW consultation URL does not contain IDM",
  );
}

export async function waitForCaptchaIfPresent(
  page: Page,
  timeoutMs: number,
  budget: AwCaptchaSolveBudget,
): Promise<void> {
  const captchaField = page.locator("#texteCaptcha").first();
  if ((await captchaField.count()) === 0) return;
  const currentValue = await captchaField.inputValue().catch(() => "");
  if (currentValue.trim().length > 0) return;
  budget.commitSolve();
  try {
    await page.waitForFunction(
      () => {
        const field = document.querySelector<HTMLInputElement>("#texteCaptcha");
        return Boolean(field?.value.trim());
      },
      undefined,
      { timeout: timeoutMs },
    );
  } catch {
    throw new AwAdapterError(
      "CAPTCHA_UNSOLVED",
      true,
      "Browserless did not solve the AW CAPTCHA in time",
    );
  }
}

async function waitForAwEntrySurface(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const candidates = [
    page.locator('#username, input[name="username"]').first(),
    page.getByText(/RETRAIT ANONYME/i).first(),
    page.getByText(CHOIX_DCE_IDENTIFICATION_PATTERN).first(),
    page.locator("#texteCaptcha, #selectAll").first(),
  ];
  await Promise.any(
    candidates.map((candidate) =>
      candidate.waitFor({ state: "visible", timeout: timeoutMs }),
    ),
  ).catch(() => undefined);
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

interface AwCredentials {
  email: string;
  password: string;
}

async function selectBsaPartnersEntityIfPrompted(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const entityLabel = page.getByText(/^BSA PARTNERS$/i).first();
  if (!(await entityLabel.isVisible().catch(() => false))) return;

  const entityControl = entityLabel
    .locator(
      "xpath=ancestor-or-self::a[1] | ancestor-or-self::button[1] | ancestor-or-self::*[@role='button'][1]",
    )
    .first();
  if ((await entityControl.count()) === 0) return;
  const ariaLabel = await entityControl.getAttribute("aria-label");
  if (/compte de l'utilisateur actuel/i.test(ariaLabel ?? "")) return;
  await waitForOptionalNavigation(
    page,
    () => entityControl.click(),
    timeoutMs,
  );
}

async function locateTextControl(
  page: Page,
  pattern: RegExp,
): Promise<Locator | null> {
  const text = page.getByText(pattern).first();
  if (!(await text.isVisible().catch(() => false))) return null;
  const control = text
    .locator(
      "xpath=ancestor-or-self::a[1] | ancestor-or-self::button[1] | ancestor-or-self::label[1] | ancestor-or-self::*[@role='button'][1]",
    )
    .first();
  return (await control.count()) > 0 ? control : text;
}

export async function clickChoixDceIdentificationIfPrompted(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const cta = await locateTextControl(page, CHOIX_DCE_IDENTIFICATION_PATTERN);
  if (cta === null) return false;
  await waitForOptionalNavigation(page, () => cta.click(), timeoutMs);
  return true;
}

// AW `dematEnt.choixDCE` wall, third variant (proof re-sweep 2026-07-20
// evening): no RETRAIT ANONYME button and no login form — the anonymous
// withdrawal sits behind a plain link ("retirer le DCE en mode anonyme",
// fuseaction=dce.avertissement) whose landing page exposes the surface this
// adapter already handles (RETRAIT ANONYME + #texteCaptcha +
// XFAOK=dce.verifLotsDCE).
const AW_ANONYMOUS_WITHDRAWAL_LINK_SELECTOR =
  'a[href*="fuseaction=dce.avertissement" i]';

export async function followAnonymousWithdrawalLinkIfPresented(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const link = page.locator(AW_ANONYMOUS_WITHDRAWAL_LINK_SELECTOR).first();
  if (!(await link.isVisible().catch(() => false))) return false;
  await waitForOptionalNavigation(page, () => link.click(), timeoutMs);
  return true;
}

export async function chooseDceCompletIfPrompted(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const option = await locateTextControl(page, DCE_COMPLET_PATTERN);
  if (option === null) return false;
  await waitForOptionalNavigation(page, () => option.click(), timeoutMs);
  const confirm = await locateTextControl(page, VALIDATE_PATTERN);
  if (confirm !== null) {
    await waitForOptionalNavigation(page, () => confirm.click(), timeoutMs);
  }
  return true;
}

export async function authenticateAwIfPrompted(
  page: Page,
  credentials: AwCredentials,
  timeoutMs: number,
): Promise<void> {
  const username = page
    .locator(
      '#username, input[name="username"], input[type="email"], input[name*="mail" i]',
    )
    .first();
  const password = page.locator('input[type="password"]').first();
  if (!(await username.isVisible().catch(() => false))) {
    await username
      .waitFor({ state: "visible", timeout: timeoutMs })
      .catch(() => undefined);
  }
  if (!(await password.isVisible().catch(() => false))) {
    await password
      .waitFor({ state: "visible", timeout: timeoutMs })
      .catch(() => undefined);
  }
  if (
    !(await username.isVisible().catch(() => false)) ||
    !(await password.isVisible().catch(() => false))
  ) {
    throw new AwAdapterError(
      "PROFILE_LINK_NOT_FINAL",
      false,
      "AW anonymous withdrawal and login form are unavailable",
    );
  }
  await username.fill(credentials.email);
  await password.fill(credentials.password);
  const submit = page
    .locator('#kc-login, button[type="submit"], input[type="submit"]')
    .first();
  if ((await submit.count()) === 0) {
    throw new AwAdapterError(
      "ADAPTER_FAILURE",
      false,
      "AW login submit control is unavailable",
    );
  }
  await waitForOptionalNavigation(page, () => submit.click(), timeoutMs);

  const authenticationError = page
    .locator("#input-error, .kc-feedback-text")
    .first();
  if (await authenticationError.isVisible().catch(() => false)) {
    throw new AwAdapterError(
      "AW_AUTHENTICATION_REJECTED",
      false,
      "AW authentication was rejected",
    );
  }
  await selectBsaPartnersEntityIfPrompted(page, timeoutMs);
}

export function locateAwLotSelectionForm(page: Page): Locator {
  return page
    .locator("form")
    .filter({ has: page.locator("#selectAll") })
    .first();
}

export class PlaywrightAwBrowserSession implements AwBrowserSession {
  private readonly timeoutMs: number;

  constructor(private readonly options: PlaywrightAwSessionOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async discover(request: RecoveryRequest): Promise<AwBrowserDiscovery> {
    let browser: Browser | undefined;
    const captchaBudget =
      this.options.captchaBudget ?? new AwCaptchaSolveBudget();
    try {
      browser = await chromium.connectOverCDP(
        buildBrowserlessEndpoint(this.options.browserlessToken),
        { timeout: this.timeoutMs },
      );
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(request.providedUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      await waitForAwEntrySurface(page, this.timeoutMs);

      const anonymousButton = page.getByText(/RETRAIT ANONYME/i).first();
      if (!(await anonymousButton.isVisible().catch(() => false))) {
        // The choixDCE wall may hold its own identification CAPTCHA. Follow
        // the anonymous-withdrawal link before funding any solve so the
        // single per-attempt solve is spent on the form this flow actually
        // submits (the landing page's anonymous RETRAIT form).
        const followed = await followAnonymousWithdrawalLinkIfPresented(
          page,
          this.timeoutMs,
        );
        if (followed) {
          await waitForAwEntrySurface(page, this.timeoutMs);
        }
      }
      await waitForCaptchaIfPresent(page, this.timeoutMs, captchaBudget);

      let dceCompletChosen = false;
      if (await anonymousButton.isVisible().catch(() => false)) {
        await waitForOptionalNavigation(
          page,
          () => anonymousButton.click(),
          this.timeoutMs,
        );
      } else {
        await clickChoixDceIdentificationIfPrompted(page, this.timeoutMs);
        await authenticateAwIfPrompted(
          page,
          {
            email: this.options.awPortalEmail,
            password: this.options.awPortalPassword,
          },
          this.timeoutMs,
        );
        if (request.requestedLots.kind === "all") {
          dceCompletChosen = await chooseDceCompletIfPrompted(
            page,
            this.timeoutMs,
          );
        }
        await waitForCaptchaIfPresent(page, this.timeoutMs, captchaBudget);
      }

      const lotForm = locateAwLotSelectionForm(page);
      const completeDceWithoutLotForm =
        dceCompletChosen && (await lotForm.count()) === 0;
      if (!completeDceWithoutLotForm) {
        await this.selectLots(page, request);
        const form = locateAwLotSelectionForm(page);
        if ((await form.count()) === 0) {
          throw new AwAdapterError(
            "ADAPTER_FAILURE",
            false,
            "AW lot selection form is unavailable",
          );
        }
        await waitForOptionalNavigation(
          page,
          () =>
            form.evaluate((element) => {
              (element as HTMLFormElement).requestSubmit();
            }),
          this.timeoutMs,
        );
      }

      const sourceUrl = new URL(request.providedUrl);
      const cookies = await context.cookies([sourceUrl.origin]);
      return {
        consultationUrl: request.providedUrl,
        consultationId: extractConsultationId(request.providedUrl),
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
      if (error instanceof AwAdapterError) throw error;
      throw new AwAdapterError(
        "ADAPTER_FAILURE",
        true,
        "Browserless AW discovery failed",
      );
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private async selectLots(page: Page, request: RecoveryRequest): Promise<void> {
    if (request.requestedLots.kind === "all") {
      const selectAll = page.locator("#selectAll").first();
      if ((await selectAll.count()) === 0) {
        throw new AwAdapterError(
          "ADAPTER_FAILURE",
          false,
          "AW select-all control is unavailable",
        );
      }
      await selectAll.check();
      return;
    }

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
      throw new AwAdapterError(
        "ADAPTER_FAILURE",
        false,
        "One or more requested AW lots are unavailable",
      );
    }
  }
}
