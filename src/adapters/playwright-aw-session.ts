import { chromium, type Browser, type Page } from "playwright-core";

import type { RecoveryRequest } from "../contracts.js";
import {
  AwAdapterError,
  type AwBrowserDiscovery,
  type AwBrowserSession,
} from "./aw-solutions.js";

const DEFAULT_TIMEOUT_MS = 45_000;

export interface PlaywrightAwSessionOptions {
  browserlessToken: string;
  awPortalEmail: string;
  awPortalPassword: string;
  timeoutMs?: number;
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

async function waitForCaptchaIfPresent(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const captchaField = page.locator("#texteCaptcha").first();
  if ((await captchaField.count()) === 0) return;
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

export class PlaywrightAwBrowserSession implements AwBrowserSession {
  private readonly timeoutMs: number;

  constructor(private readonly options: PlaywrightAwSessionOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async discover(request: RecoveryRequest): Promise<AwBrowserDiscovery> {
    let browser: Browser | undefined;
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
      await waitForCaptchaIfPresent(page, this.timeoutMs);

      const anonymousButton = page.getByText(/RETRAIT ANONYME/i).first();
      if (await anonymousButton.isVisible().catch(() => false)) {
        await waitForOptionalNavigation(
          page,
          () => anonymousButton.click(),
          this.timeoutMs,
        );
      } else {
        await this.authenticateIfPrompted(page);
      }

      await this.selectLots(page, request);
      const form = page
        .locator("form")
        .filter({ has: page.locator("#selectAll") })
        .first();
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

  private async authenticateIfPrompted(page: Page): Promise<void> {
    const email = page
      .locator('input[type="email"], input[name*="mail" i]')
      .first();
    const password = page.locator('input[type="password"]').first();
    if (
      !(await email.isVisible().catch(() => false)) ||
      !(await password.isVisible().catch(() => false))
    ) {
      throw new AwAdapterError(
        "PROFILE_LINK_NOT_FINAL",
        false,
        "AW anonymous withdrawal and login form are unavailable",
      );
    }
    await email.fill(this.options.awPortalEmail);
    await password.fill(this.options.awPortalPassword);
    const submit = page.locator('button[type="submit"], input[type="submit"]').first();
    if ((await submit.count()) === 0) {
      throw new AwAdapterError(
        "ADAPTER_FAILURE",
        false,
        "AW login submit control is unavailable",
      );
    }
    await waitForOptionalNavigation(
      page,
      () => submit.click(),
      this.timeoutMs,
    );
    await waitForCaptchaIfPresent(page, this.timeoutMs);
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
