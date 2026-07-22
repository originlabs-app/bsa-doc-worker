import {
  chromium,
  type Browser,
  type Locator,
  type Page,
} from "playwright-core";

import type { RecoveryRequest } from "../contracts.js";
import type { WorkerLogger } from "../logger.js";
import {
  AwAdapterError,
  type AwBrowserDiscovery,
  type AwBrowserSession,
} from "./aw-solutions.js";
import { sanitizeRecoveryFailureMessage } from "../recovery/failure.js";
import type {
  RecoveryFailureStage,
  RecoveryFailureType,
} from "../recovery/contracts.js";

const DEFAULT_TIMEOUT_MS = 45_000;

// Browserless bills a CAPTCHA solve at 10 units. Autonomous recovery injects
// one shared budget instance for the whole one-shot run.
export const AW_CAPTCHA_SOLVE_UNIT_COST = 10;
export const AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_RUN = 10;
// Compatibility alias for the legacy manifest worker, which creates its own
// budget for each standalone discovery attempt.
export const AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_ATTEMPT =
  AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_RUN;

export class AwCaptchaSolveBudget {
  private committedUnits = 0;

  get unitsCommitted(): number {
    return this.committedUnits;
  }

  commitSolve(): void {
    if (
      this.committedUnits + AW_CAPTCHA_SOLVE_UNIT_COST >
      AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_RUN
    ) {
      throw new AwAdapterError(
        "CAPTCHA_UNSOLVED",
        true,
        "AW CAPTCHA solve budget for this run is exhausted",
        { stage: "captcha", type: "captcha" },
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
  logger?: WorkerLogger;
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
    { stage: "identification", type: "validation" },
  );
}

type AwFlowStep =
  | "connect"
  | "goto"
  | "entry_surface"
  | "captcha"
  | "anonymous_withdrawal"
  | "authenticate"
  | "lot_selection"
  | "listing";

function failureMetadata(
  step: AwFlowStep,
  reasonCode?: string,
): { stage: RecoveryFailureStage; type: RecoveryFailureType } {
  if (/CAPTCHA/.test(reasonCode ?? "") || step === "captcha") {
    return { stage: "captcha", type: "captcha" };
  }
  if (/AUTHENTICATION/.test(reasonCode ?? "") || step === "authenticate") {
    return { stage: "authentication", type: "login" };
  }
  if (step === "connect") return { stage: "browser_connect", type: "network" };
  if (step === "goto") return { stage: "navigation", type: "network" };
  if (step === "lot_selection") {
    return { stage: "lot_selection", type: "navigation" };
  }
  if (step === "listing") return { stage: "manifest", type: "validation" };
  return { stage: "navigation", type: "navigation" };
}

// The Browserless.solveCaptcha CDP command is bounded independently of the
// page timeout so a hanging solver can never stall a whole attempt.
const CAPTCHA_SOLVE_COMMAND_TIMEOUT_MS = 30_000;

export interface AwCaptchaSolveVerdict {
  solved: boolean;
  detail: string;
}

interface RawBrowserlessSolveResult {
  found?: boolean;
  solved?: boolean;
  error?: string;
}

interface MinimalCdpSession {
  send(method: string): Promise<unknown>;
  detach(): Promise<void>;
}

// Exactly ONE explicit Browserless.solveCaptcha call — no retry loop. It
// never throws: the #texteCaptcha field value stays the single source of
// truth, this verdict only feeds diagnostics and the failure message.
export async function solveAwCaptchaOnce(
  page: Page,
  timeoutMs: number,
): Promise<AwCaptchaSolveVerdict> {
  let session: MinimalCdpSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    session = (await page
      .context()
      .newCDPSession(page)) as unknown as MinimalCdpSession;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("solve command timeout")),
        Math.min(timeoutMs, CAPTCHA_SOLVE_COMMAND_TIMEOUT_MS),
      );
    });
    const raw = (await Promise.race([
      session.send("Browserless.solveCaptcha"),
      timeout,
    ])) as RawBrowserlessSolveResult | undefined;
    if (raw?.solved === true) {
      return { solved: true, detail: "browserless_solved" };
    }
    if (raw?.found === false) {
      return { solved: false, detail: "captcha_not_recognized_by_browserless" };
    }
    return {
      solved: false,
      detail: raw?.error
        ? `browserless_error:${raw.error}`.slice(0, 200)
        : "browserless_unsolved",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return {
      solved: false,
      detail: `cdp_unavailable:${message}`.slice(0, 200),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await session?.detach().catch(() => undefined);
  }
}

export async function waitForCaptchaIfPresent(
  page: Page,
  timeoutMs: number,
  budget: AwCaptchaSolveBudget,
  logger?: WorkerLogger,
): Promise<void> {
  const captchaField = page.locator("#texteCaptcha").first();
  if ((await captchaField.count()) === 0) return;
  const currentValue = await captchaField.inputValue().catch(() => "");
  if (currentValue.trim().length > 0) return;
  logger?.info("recovery_aw_captcha_detected", {
    portal: "aw_solutions",
    wall: "aw_image_captcha",
  });
  try {
    budget.commitSolve();
  } catch (error) {
    logger?.info("recovery_aw_captcha_unsolved", {
      portal: "aw_solutions",
      wall: "aw_image_captcha",
      detail: "solve_budget_exhausted",
    });
    throw error;
  }
  const verdict = await solveAwCaptchaOnce(page, timeoutMs);
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
    logger?.info("recovery_aw_captcha_unsolved", {
      portal: "aw_solutions",
      wall: "aw_image_captcha",
      detail: verdict.detail,
      solver_solved: verdict.solved,
    });
    throw new AwAdapterError(
      "CAPTCHA_UNSOLVED",
      true,
      `Browserless did not solve the AW CAPTCHA (${verdict.detail})`,
    );
  }
  logger?.info("recovery_aw_captcha_solved", {
    portal: "aw_solutions",
    wall: "aw_image_captcha",
    detail: verdict.detail,
  });
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

function awRejectedCaptcha(page: Page): boolean {
  try {
    const url = new URL(page.url());
    for (const [key, value] of url.searchParams) {
      if (
        key.toLowerCase() === "typeerreur" &&
        value.toLowerCase() === "captcha"
      ) {
        return true;
      }
    }
  } catch {
    // A malformed browser URL is handled by the next guarded flow step.
  }
  return false;
}

function throwIfAwRejectedCaptcha(
  page: Page,
  logger?: WorkerLogger,
): void {
  if (!awRejectedCaptcha(page)) return;
  logger?.info("recovery_aw_captcha_rejected", {
    portal: "aw_solutions",
    wall: "aw_image_captcha",
    detail: "aw_rejected_answer",
  });
  throw new AwAdapterError(
    "CAPTCHA_UNSOLVED",
    true,
    "AW rejected the Browserless CAPTCHA answer",
    { stage: "captcha", type: "captcha" },
  );
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
    // Names the flow step in every unexpected failure so a prod 'error'
    // attempt is never mute about where AW actually broke.
    let step: AwFlowStep = "connect";
    try {
      browser = await chromium.connectOverCDP(
        buildBrowserlessEndpoint(this.options.browserlessToken),
        { timeout: this.timeoutMs },
      );
      step = "goto";
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(request.providedUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      step = "entry_surface";
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
      step = "captcha";
      await waitForCaptchaIfPresent(
        page,
        this.timeoutMs,
        captchaBudget,
        this.options.logger,
      );

      let dceCompletChosen = false;
      if (await anonymousButton.isVisible().catch(() => false)) {
        step = "anonymous_withdrawal";
        await waitForOptionalNavigation(
          page,
          () => anonymousButton.click(),
          this.timeoutMs,
        );
        step = "captcha";
        throwIfAwRejectedCaptcha(page, this.options.logger);
      } else {
        step = "authenticate";
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
        step = "captcha";
        await waitForCaptchaIfPresent(
          page,
          this.timeoutMs,
          captchaBudget,
          this.options.logger,
        );
      }

      step = "lot_selection";
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

      step = "listing";
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
      if (error instanceof AwAdapterError) {
        const metadata = failureMetadata(step, error.reasonCode);
        throw new AwAdapterError(
          error.reasonCode,
          error.retryable,
          sanitizeRecoveryFailureMessage(error.message),
          metadata,
        );
      }
      const message = sanitizeRecoveryFailureMessage(
        error instanceof Error ? error.message : String(error),
      );
      throw new AwAdapterError(
        "ADAPTER_FAILURE",
        true,
        `Browserless AW discovery failed at ${step}: ${message}`.slice(0, 300),
        failureMetadata(step),
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
