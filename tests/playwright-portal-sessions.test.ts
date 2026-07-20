import { describe, expect, it, vi } from "vitest";

import type { PortalAdapterError } from "../src/adapters/portal-adapter-error.js";
import {
  authenticatePortalIfPrompted,
  ensureCaptchaSolved,
  extractPortalConsultationId,
  isSafeManifestControlTarget,
} from "../src/adapters/playwright-portal-session.js";
import { PlaywrightMaximilienBrowserSession } from "../src/adapters/playwright-maximilien-session.js";
import { PlaywrightPlaceBrowserSession } from "../src/adapters/playwright-place-session.js";

interface LocatorState {
  count?: number;
  visible?: boolean;
}

function fakePage(states: Record<string, LocatorState>) {
  const filled: Array<[string, string]> = [];
  const clicked: string[] = [];
  const page = {
    locator: vi.fn((selector: string) => {
      const state = states[selector] ?? {};
      return {
        first: () => ({
          count: async () => state.count ?? (state.visible ? 1 : 0),
          isVisible: async () => state.visible ?? false,
          waitFor: async () => undefined,
          fill: async (value: string) => filled.push([selector, value]),
          click: async () => clicked.push(selector),
        }),
      };
    }),
    waitForNavigation: vi.fn(async () => null),
    waitForFunction: vi.fn(async () => undefined),
  };
  return { page, filled, clicked };
}

describe("portal Playwright session helpers", () => {
  it("fills a direct login form without exposing credentials", async () => {
    const usernameSelector =
      'input[type="email"], input[name*="mail" i], input[name*="login" i], input[name*="user" i], input[autocomplete="username"]';
    const passwordSelector = 'input[type="password"]';
    const submitSelector =
      'button[type="submit"], input[type="submit"], button[name*="login" i]';
    const { page, filled, clicked } = fakePage({
      [usernameSelector]: { visible: true },
      [passwordSelector]: { visible: true },
      [submitSelector]: { count: 1 },
    });

    const authenticated = await authenticatePortalIfPrompted(
      page as never,
      { email: "operator@example.test", password: "fixture-password" },
      "PLACE",
      1_000,
    );

    expect(filled).toEqual([
      [usernameSelector, "operator@example.test"],
      [passwordSelector, "fixture-password"],
    ]);
    expect(clicked).toEqual([submitSelector]);
    expect(authenticated).toBe(true);
  });

  it("returns a typed block when portal authentication is rejected", async () => {
    const { page } = fakePage({
      'input[type="email"], input[name*="mail" i], input[name*="login" i], input[name*="user" i], input[autocomplete="username"]': {
        visible: true,
      },
      'input[type="password"]': { visible: true },
      'button[type="submit"], input[type="submit"], button[name*="login" i]': {
        count: 1,
      },
      '[role="alert"], .alert-danger, .error, .authentication-error': {
        visible: true,
      },
    });

    await expect(
      authenticatePortalIfPrompted(
        page as never,
        { email: "operator@example.test", password: "wrong" },
        "Maximilien",
        1_000,
      ),
    ).rejects.toMatchObject({
      reasonCode: "PORTAL_AUTHENTICATION_REJECTED",
      retryable: false,
    } satisfies Partial<PortalAdapterError>);
  });

  it("returns a retryable block when Browserless cannot solve a CAPTCHA", async () => {
    const captchaSelector =
      'input[id*="captcha" i], input[name*="captcha" i], textarea[name*="captcha" i]';
    const { page } = fakePage({
      [captchaSelector]: { visible: true },
    });
    page.waitForFunction.mockRejectedValueOnce(new Error("fixture timeout"));

    await expect(
      ensureCaptchaSolved(page as never, 1_000, "PLACE"),
    ).rejects.toMatchObject({
      reasonCode: "CAPTCHA_UNSOLVED",
      retryable: true,
    } satisfies Partial<PortalAdapterError>);
  });

  it("extracts consultation ids only from the expected portal", () => {
    expect(
      extractPortalConsultationId(
        "https://www.marches-publics.gouv.fr/app.php/entreprise/consultation/3036454",
        "marches-publics.gouv.fr",
      ),
    ).toBe("3036454");
    expect(() =>
      extractPortalConsultationId(
        "https://attacker.invalid/consultation/3036454",
        "marches-publics.gouv.fr",
      ),
    ).toThrow("Portal consultation URL is not final");
  });

  it("constructs distinct PLACE and Maximilien sessions", () => {
    expect(
      new PlaywrightPlaceBrowserSession({
        browserlessToken: "fixture-token",
        placePortalEmail: "place@example.test",
        placePortalPassword: "fixture-password",
      }),
    ).toBeInstanceOf(PlaywrightPlaceBrowserSession);
    expect(
      new PlaywrightMaximilienBrowserSession({
        browserlessToken: "fixture-token",
        maximilienPortalEmail: "max@example.test",
        maximilienPortalPassword: "fixture-password",
      }),
    ).toBeInstanceOf(PlaywrightMaximilienBrowserSession);
  });

  it("never treats an attachment or external URL as a manifest control", () => {
    const currentUrl =
      "https://www.marches-publics.gouv.fr/entreprise/consultation/3036454";

    expect(
      isSafeManifestControlTarget(
        "/entreprise/consultation/3036454/documents",
        currentUrl,
        "marches-publics.gouv.fr",
      ),
    ).toBe(true);
    expect(
      isSafeManifestControlTarget(
        "/dce/download/package-3036454",
        currentUrl,
        "marches-publics.gouv.fr",
      ),
    ).toBe(false);
    expect(
      isSafeManifestControlTarget(
        "https://attacker.invalid/consultation/3036454/documents",
        currentUrl,
        "marches-publics.gouv.fr",
      ),
    ).toBe(false);
  });
});
