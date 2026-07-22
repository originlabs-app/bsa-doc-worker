import { chromium } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import type { AwAdapterError } from "../src/adapters/aw-solutions.js";
import {
  AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_RUN,
  AW_CAPTCHA_SOLVE_UNIT_COST,
  AwCaptchaSolveBudget,
  PlaywrightAwBrowserSession,
  authenticateAwIfPrompted,
  chooseDceCompletIfPrompted,
  clickChoixDceIdentificationIfPrompted,
  followAnonymousWithdrawalLinkIfPresented,
  locateAwLotSelectionForm,
  solveAwCaptchaOnce,
  waitForCaptchaIfPresent,
} from "../src/adapters/playwright-aw-session.js";
import type { RecoveryRequest } from "../src/contracts.js";
import type { LogRecord, WorkerLogger } from "../src/logger.js";

vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP: vi.fn() },
}));

interface LocatorState {
  ariaLabel?: string;
  visible?: boolean;
  visibleAfterWait?: boolean;
  count?: number;
}

function fakePage(
  states: Record<string, LocatorState>,
  entityState: LocatorState = {},
) {
  const filled: Array<[string, string]> = [];
  const clicked: string[] = [];
  const page = {
    locator: vi.fn((selector: string) => {
      const state = states[selector] ?? {};
      return {
        first: () => ({
          count: async () => state.count ?? (state.visible ? 1 : 0),
          isVisible: async () => state.visible ?? false,
          waitFor: async () => {
            if (state.visibleAfterWait !== undefined) {
              state.visible = state.visibleAfterWait;
            }
          },
          fill: async (value: string) => {
            filled.push([selector, value]);
          },
          click: async () => {
            clicked.push(selector);
          },
        }),
      };
    }),
    getByText: vi.fn(() => ({
      first: () => ({
        isVisible: async () => entityState.visible ?? false,
        locator: () => ({
          first: () => ({
            count: async () => entityState.count ?? 0,
            getAttribute: async (name: string) =>
              name === "aria-label" ? (entityState.ariaLabel ?? null) : null,
            click: async () => {
              clicked.push("BSA PARTNERS");
            },
          }),
        }),
      }),
    })),
    waitForNavigation: vi.fn(async () => null),
  };
  return { page, filled, clicked };
}

describe("authenticateAwIfPrompted", () => {
  it("uses the real Keycloak username and submit controls", async () => {
    const usernameSelector =
      '#username, input[name="username"], input[type="email"], input[name*="mail" i]';
    const submitSelector =
      '#kc-login, button[type="submit"], input[type="submit"]';
    const { page, filled, clicked } = fakePage({
      [usernameSelector]: { visible: true },
      'input[type="password"]': { visible: true },
      [submitSelector]: { count: 1 },
    });

    await authenticateAwIfPrompted(
      page as never,
      { email: "operator@example.test", password: "fixture-password" },
      1_000,
    );

    expect(filled).toEqual([
      [usernameSelector, "operator@example.test"],
      ['input[type="password"]', "fixture-password"],
    ]);
    expect(clicked).toEqual([submitSelector]);
  });

  it("waits for the asynchronous APR redirect to the Keycloak form", async () => {
    const usernameSelector =
      '#username, input[name="username"], input[type="email"], input[name*="mail" i]';
    const { page, filled } = fakePage({
      [usernameSelector]: { visible: false, visibleAfterWait: true },
      'input[type="password"]': { visible: true },
      '#kc-login, button[type="submit"], input[type="submit"]': { count: 1 },
    });

    await authenticateAwIfPrompted(
      page as never,
      { email: "operator@example.test", password: "fixture-password" },
      1_000,
    );

    expect(filled[0]).toEqual([usernameSelector, "operator@example.test"]);
  });

  it("selects the BSA PARTNERS entity when Keycloak presents it", async () => {
    const { page, clicked } = fakePage(
      {
        '#username, input[name="username"], input[type="email"], input[name*="mail" i]': {
          visible: true,
        },
        'input[type="password"]': { visible: true },
        '#kc-login, button[type="submit"], input[type="submit"]': { count: 1 },
      },
      { visible: true, count: 1 },
    );

    await authenticateAwIfPrompted(
      page as never,
      { email: "operator@example.test", password: "fixture-password" },
      1_000,
    );

    expect(clicked).toEqual([
      '#kc-login, button[type="submit"], input[type="submit"]',
      "BSA PARTNERS",
    ]);
  });

  it("does not click BSA PARTNERS when it is already the current entity", async () => {
    const { page, clicked } = fakePage(
      {
        '#username, input[name="username"], input[type="email"], input[name*="mail" i]': {
          visible: true,
        },
        'input[type="password"]': { visible: true },
        '#kc-login, button[type="submit"], input[type="submit"]': { count: 1 },
      },
      {
        visible: true,
        count: 1,
        ariaLabel: "Compte de l'utilisateur actuel",
      },
    );

    await authenticateAwIfPrompted(
      page as never,
      { email: "operator@example.test", password: "fixture-password" },
      1_000,
    );

    expect(clicked).toEqual([
      '#kc-login, button[type="submit"], input[type="submit"]',
    ]);
  });

  it("reports a rejected Keycloak login without retrying", async () => {
    const { page } = fakePage({
      '#username, input[name="username"], input[type="email"], input[name*="mail" i]': {
        visible: true,
      },
      'input[type="password"]': { visible: true },
      '#kc-login, button[type="submit"], input[type="submit"]': { count: 1 },
      "#input-error, .kc-feedback-text": { visible: true },
    });

    await expect(
      authenticateAwIfPrompted(
        page as never,
        { email: "operator@example.test", password: "wrong" },
        1_000,
      ),
    ).rejects.toMatchObject({
      reasonCode: "AW_AUTHENTICATION_REJECTED",
      retryable: false,
    } satisfies Partial<AwAdapterError>);
  });
});

describe("locateAwLotSelectionForm", () => {
  it("selects the form containing the AW lot control without nesting forms", () => {
    const selected = { first: () => "lot-form" };
    const filter = (options: unknown) => {
      expect(options).toEqual({ has: "select-all" });
      return selected;
    };
    const page = {
      locator: (selector: string) => {
        if (selector === "#selectAll") return "select-all";
        expect(selector).toBe("form");
        return { filter };
      },
    };

    expect(locateAwLotSelectionForm(page as never)).toBe("lot-form");
  });
});

interface TextControlState {
  visible: boolean;
  controlCount?: number;
}

function fakeChoixDcePage(options: {
  textTargets?: Record<string, TextControlState>;
  captcha?: { present: boolean; value?: string; solves?: boolean };
  anonymousLink?: { visible: boolean };
  cdpResult?: { found?: boolean; solved?: boolean; error?: string };
}) {
  const clicked: string[] = [];
  const cdpSend = vi.fn(async (method: string) => {
    expect(method).toBe("Browserless.solveCaptcha");
    return options.cdpResult;
  });
  const cdpDetach = vi.fn(async () => undefined);
  const waitForFunction = vi.fn(async () => {
    if (options.captcha?.solves !== true) throw new Error("fixture timeout");
  });
  const page = {
    ...(options.cdpResult
      ? {
          context: () => ({
            newCDPSession: async () => ({ send: cdpSend, detach: cdpDetach }),
          }),
        }
      : {}),
    locator: (selector: string) => ({
      first: () => ({
        count: async () =>
          selector === "#texteCaptcha" && options.captcha?.present ? 1 : 0,
        inputValue: async () => options.captcha?.value ?? "",
        isVisible: async () =>
          selector.includes("dce.avertissement") &&
          (options.anonymousLink?.visible ?? false),
        click: async () => {
          clicked.push(`locator:${selector}`);
        },
      }),
    }),
    getByText: (pattern: RegExp) => {
      const entry = Object.entries(options.textTargets ?? {}).find(([label]) =>
        pattern.test(label),
      );
      const label = entry?.[0] ?? String(pattern);
      const state = entry?.[1];
      return {
        first: () => ({
          isVisible: async () => state?.visible ?? false,
          click: async () => {
            clicked.push(`text:${label}`);
          },
          locator: () => ({
            first: () => ({
              count: async () => state?.controlCount ?? 0,
              click: async () => {
                clicked.push(`control:${label}`);
              },
            }),
          }),
        }),
      };
    },
    waitForNavigation: vi.fn(async () => null),
    waitForFunction,
  };
  return { page, clicked, waitForFunction, cdpSend, cdpDetach };
}

function captureLogger() {
  const events: Array<{ event: string; record: LogRecord }> = [];
  const logger: WorkerLogger = {
    info: (event, record) => {
      events.push({ event, record });
    },
  };
  return { logger, events };
}

describe("clickChoixDceIdentificationIfPrompted", () => {
  it("clicks the identification link on the choixDCE wall", async () => {
    const wall = "POUR RETIRER UN DCE, VOUS DEVEZ VOUS IDENTIFIER";
    const { page, clicked } = fakeChoixDcePage({
      textTargets: { [wall]: { visible: true, controlCount: 1 } },
    });

    await expect(
      clickChoixDceIdentificationIfPrompted(page as never, 1_000),
    ).resolves.toBe(true);
    expect(clicked).toEqual([`control:${wall}`]);
  });

  it("does nothing when no identification wall is shown", async () => {
    const { page, clicked } = fakeChoixDcePage({});

    await expect(
      clickChoixDceIdentificationIfPrompted(page as never, 1_000),
    ).resolves.toBe(false);
    expect(clicked).toEqual([]);
  });
});

describe("chooseDceCompletIfPrompted", () => {
  it("selects the DCE complet option and validates the choice", async () => {
    const { page, clicked } = fakeChoixDcePage({
      textTargets: {
        "Télécharger le DCE complet": { visible: true, controlCount: 1 },
        Valider: { visible: true, controlCount: 1 },
      },
    });

    await expect(
      chooseDceCompletIfPrompted(page as never, 1_000),
    ).resolves.toBe(true);
    expect(clicked).toEqual([
      "control:Télécharger le DCE complet",
      "control:Valider",
    ]);
  });

  it("clicks the option text directly when no wrapping control exists", async () => {
    const { page, clicked } = fakeChoixDcePage({
      textTargets: {
        "DCE complet": { visible: true, controlCount: 0 },
      },
    });

    await expect(
      chooseDceCompletIfPrompted(page as never, 1_000),
    ).resolves.toBe(true);
    expect(clicked).toEqual(["text:DCE complet"]);
  });

  it("returns false when the surface offers no DCE complet choice", async () => {
    const { page, clicked } = fakeChoixDcePage({});

    await expect(
      chooseDceCompletIfPrompted(page as never, 1_000),
    ).resolves.toBe(false);
    expect(clicked).toEqual([]);
  });
});

describe("followAnonymousWithdrawalLinkIfPresented", () => {
  it("follows the choixDCE anonymous withdrawal link when presented", async () => {
    const { page, clicked } = fakeChoixDcePage({
      anonymousLink: { visible: true },
    });

    await expect(
      followAnonymousWithdrawalLinkIfPresented(page as never, 1_000),
    ).resolves.toBe(true);
    expect(clicked).toEqual([
      'locator:a[href*="fuseaction=dce.avertissement" i]',
    ]);
  });

  it("does nothing when the wall offers no anonymous link", async () => {
    const { page, clicked } = fakeChoixDcePage({});

    await expect(
      followAnonymousWithdrawalLinkIfPresented(page as never, 1_000),
    ).resolves.toBe(false);
    expect(clicked).toEqual([]);
  });
});

type AwSurface =
  | "choixDCE"
  | "avertissement"
  | "captcha_rejected"
  | "lots"
  | "submitted";

// State-machine fake of the AW anonymous-withdrawal journey. `choixDCE` is
// the 2026-07-20 evening wall: no RETRAIT ANONYME button, no login form, an
// identification CAPTCHA the flow must NOT fund, and the plain
// `dce.avertissement` link. Its landing page (`avertissement`) carries the
// proven RETRAIT ANONYME + #texteCaptcha surface leading to the lot form.
function fakeAwDiscoverFlow(
  initialSurface: "choixDCE" | "avertissement",
  afterAnonymous: "lots" | "captcha_rejected" = "lots",
) {
  let surface: AwSurface = initialSurface;
  const clicked: string[] = [];
  const captchaSolveSurfaces: string[] = [];
  let selectAllChecked = false;
  let lotFormSubmitted = false;

  const captchaPresent = () =>
    surface === "choixDCE" || surface === "avertissement";
  const anonymousButtonPattern = /RETRAIT ANONYME/i;

  const locatorFor = (selector: string) => ({
    count: async () => {
      if (selector === "#texteCaptcha") return captchaPresent() ? 1 : 0;
      if (selector === "#selectAll") return surface === "lots" ? 1 : 0;
      return 0;
    },
    inputValue: async () => "",
    isVisible: async () =>
      selector.includes("dce.avertissement") && surface === "choixDCE",
    waitFor: async () => {
      const visible =
        selector === "#texteCaptcha, #selectAll" &&
        (captchaPresent() || surface === "lots");
      if (!visible) throw new Error(`fixture: not visible (${selector})`);
    },
    click: async () => {
      if (selector.includes("dce.avertissement")) {
        clicked.push("anonymous-link");
        if (surface === "choixDCE") surface = "avertissement";
        return;
      }
      clicked.push(selector);
    },
    check: async () => {
      if (selector === "#selectAll" && surface === "lots") {
        selectAllChecked = true;
      }
    },
  });

  const lotForm = {
    count: async () => (surface === "lots" ? 1 : 0),
    evaluate: async () => {
      lotFormSubmitted = true;
      surface = "submitted";
    },
  };

  const page = {
    goto: vi.fn(async () => null),
    locator: (selector: string) => {
      if (selector === "form") {
        return { filter: () => ({ first: () => lotForm }) };
      }
      return { first: () => locatorFor(selector) };
    },
    getByText: (pattern: RegExp) => ({
      first: () => ({
        isVisible: async () =>
          pattern.source === anonymousButtonPattern.source &&
          surface === "avertissement",
        waitFor: async () => {
          if (
            !(
              pattern.source === anonymousButtonPattern.source &&
              surface === "avertissement"
            )
          ) {
            throw new Error(`fixture: not visible (${pattern})`);
          }
        },
        click: async () => {
          clicked.push("RETRAIT ANONYME");
          if (surface === "avertissement") surface = afterAnonymous;
        },
        locator: () => ({ first: () => ({ count: async () => 0 }) }),
      }),
    }),
    waitForNavigation: vi.fn(async () => null),
    waitForFunction: vi.fn(async () => {
      captchaSolveSurfaces.push(surface);
    }),
    url: () =>
      surface === "captcha_rejected"
        ? "https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dce.avertissement&typeErreur=captcha"
        : "https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dce.verifLotsDCE",
    content: async () => "<html>fixture listing</html>",
    evaluate: async () => "fixture-user-agent",
  };

  const context = {
    pages: () => [page],
    cookies: async () => [
      { name: "CFID", value: "fixture-cfid" },
      { name: "CFTOKEN", value: "fixture-cftoken" },
    ],
  };
  const browser = {
    contexts: () => [context],
    close: vi.fn(async () => undefined),
  };

  return {
    browser,
    clicked,
    captchaSolveSurfaces,
    isSelectAllChecked: () => selectAllChecked,
    isLotFormSubmitted: () => lotFormSubmitted,
  };
}

describe("PlaywrightAwBrowserSession.discover", () => {
  const request: RecoveryRequest = {
    jobId: "fixture-job",
    tenderId: "fixture-tender",
    sourceField: "link_to_buyer_profile",
    providedUrl:
      "https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematEnt.login&type=DCE&IDM=1848459",
    requestedLots: { kind: "all" },
  };

  function sessionFor(
    flow: ReturnType<typeof fakeAwDiscoverFlow>,
    captchaBudget?: AwCaptchaSolveBudget,
  ) {
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(
      flow.browser as never,
    );
    return new PlaywrightAwBrowserSession({
      browserlessToken: "fixture-token",
      awPortalEmail: "operator@example.test",
      awPortalPassword: "fixture-password",
      timeoutMs: 1_000,
      ...(captchaBudget ? { captchaBudget } : {}),
    });
  }

  it("follows the choixDCE anonymous link then reaches RETRAIT ANONYME", async () => {
    const flow = fakeAwDiscoverFlow("choixDCE");

    const discovery = await sessionFor(flow).discover(request);

    expect(flow.clicked).toEqual(["anonymous-link", "RETRAIT ANONYME"]);
    // The single per-attempt CAPTCHA solve is funded on the avertissement
    // form the flow submits, never on the abandoned choixDCE wall.
    expect(flow.captchaSolveSurfaces).toEqual(["avertissement"]);
    expect(flow.isSelectAllChecked()).toBe(true);
    expect(flow.isLotFormSubmitted()).toBe(true);
    expect(discovery.consultationId).toBe("1848459");
    expect(discovery.selectedLots).toEqual(["all"]);
    expect(flow.browser.close).toHaveBeenCalled();
  });

  it("keeps the direct RETRAIT ANONYME path without an extra link hop", async () => {
    const flow = fakeAwDiscoverFlow("avertissement");

    const discovery = await sessionFor(flow).discover(request);

    expect(flow.clicked).toEqual(["RETRAIT ANONYME"]);
    expect(flow.captchaSolveSurfaces).toEqual(["avertissement"]);
    expect(flow.isLotFormSubmitted()).toBe(true);
    expect(discovery.consultationId).toBe("1848459");
  });

  it("reports AW's captcha rejection instead of a false lot-selection failure", async () => {
    const flow = fakeAwDiscoverFlow("avertissement", "captcha_rejected");

    await expect(sessionFor(flow).discover(request)).rejects.toMatchObject({
      reasonCode: "CAPTCHA_UNSOLVED",
      retryable: true,
      failureStage: "captcha",
      failureType: "captcha",
      message: "AW rejected the Browserless CAPTCHA answer",
    } satisfies Partial<AwAdapterError>);
    expect(flow.captchaSolveSurfaces).toEqual(["avertissement"]);
    expect(flow.isSelectAllChecked()).toBe(false);
    expect(flow.isLotFormSubmitted()).toBe(false);
  });

  it("shares the ten-unit CAPTCHA budget across a whole recovery run", async () => {
    const budget = new AwCaptchaSolveBudget();
    const first = fakeAwDiscoverFlow("avertissement");
    await sessionFor(first, budget).discover(request);

    const second = fakeAwDiscoverFlow("avertissement");
    await expect(sessionFor(second, budget).discover(request)).rejects.toMatchObject({
      reasonCode: "CAPTCHA_UNSOLVED",
    });
    expect(budget.unitsCommitted).toBe(10);
    expect(second.captchaSolveSurfaces).toEqual([]);
  });
});

describe("waitForCaptchaIfPresent", () => {
  it("spends no budget when the CAPTCHA is absent", async () => {
    const budget = new AwCaptchaSolveBudget();
    const { page, waitForFunction } = fakeChoixDcePage({});

    await waitForCaptchaIfPresent(page as never, 1_000, budget);

    expect(budget.unitsCommitted).toBe(0);
    expect(waitForFunction).not.toHaveBeenCalled();
  });

  it("spends no budget when the CAPTCHA is already solved", async () => {
    const budget = new AwCaptchaSolveBudget();
    const { page, waitForFunction } = fakeChoixDcePage({
      captcha: { present: true, value: "solved" },
    });

    await waitForCaptchaIfPresent(page as never, 1_000, budget);

    expect(budget.unitsCommitted).toBe(0);
    expect(waitForFunction).not.toHaveBeenCalled();
  });

  it("commits one Browserless solve when the CAPTCHA gets solved", async () => {
    const budget = new AwCaptchaSolveBudget();
    const { page } = fakeChoixDcePage({
      captcha: { present: true, solves: true },
    });

    await waitForCaptchaIfPresent(page as never, 1_000, budget);

    expect(budget.unitsCommitted).toBe(AW_CAPTCHA_SOLVE_UNIT_COST);
  });

  it("reports an unsolved CAPTCHA as retryable after committing the solve", async () => {
    const budget = new AwCaptchaSolveBudget();
    const { page } = fakeChoixDcePage({
      captcha: { present: true, solves: false },
    });

    await expect(
      waitForCaptchaIfPresent(page as never, 1_000, budget),
    ).rejects.toMatchObject({
      reasonCode: "CAPTCHA_UNSOLVED",
      retryable: true,
    } satisfies Partial<AwAdapterError>);
    expect(budget.unitsCommitted).toBe(AW_CAPTCHA_SOLVE_UNIT_COST);
  });

  it("funds at most one CAPTCHA solve per attempt and fails honestly beyond", async () => {
    const budget = new AwCaptchaSolveBudget();
    const first = fakeChoixDcePage({
      captcha: { present: true, solves: true },
    });
    await waitForCaptchaIfPresent(first.page as never, 1_000, budget);

    const second = fakeChoixDcePage({
      captcha: { present: true, solves: true },
    });
    await expect(
      waitForCaptchaIfPresent(second.page as never, 1_000, budget),
    ).rejects.toMatchObject({
      reasonCode: "CAPTCHA_UNSOLVED",
      retryable: true,
    } satisfies Partial<AwAdapterError>);

    expect(second.waitForFunction).not.toHaveBeenCalled();
    expect(budget.unitsCommitted).toBe(
      AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_RUN,
    );
  });
});

describe("solveAwCaptchaOnce", () => {
  function cdpPage(options: {
    result?: { found?: boolean; solved?: boolean; error?: string };
    sendError?: Error;
    hangs?: boolean;
  }) {
    const send = vi.fn(async (method: string) => {
      expect(method).toBe("Browserless.solveCaptcha");
      if (options.sendError) throw options.sendError;
      if (options.hangs) return new Promise(() => undefined);
      return options.result;
    });
    const detach = vi.fn(async () => undefined);
    const page = {
      context: () => ({
        newCDPSession: async () => ({ send, detach }),
      }),
    };
    return { page, send, detach };
  }

  it("reports a Browserless solve success", async () => {
    const { page, send, detach } = cdpPage({ result: { solved: true } });

    await expect(solveAwCaptchaOnce(page as never, 1_000)).resolves.toEqual({
      solved: true,
      detail: "browserless_solved",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalled();
  });

  it("reports a wall Browserless does not recognize as a CAPTCHA", async () => {
    const { page } = cdpPage({ result: { found: false, solved: false } });

    await expect(solveAwCaptchaOnce(page as never, 1_000)).resolves.toEqual({
      solved: false,
      detail: "captcha_not_recognized_by_browserless",
    });
  });

  it("surfaces the Browserless solver error text", async () => {
    const { page } = cdpPage({
      result: { found: true, solved: false, error: "unsupported captcha type" },
    });

    const verdict = await solveAwCaptchaOnce(page as never, 1_000);

    expect(verdict.solved).toBe(false);
    expect(verdict.detail).toContain("unsupported captcha type");
  });

  it("bounds a hanging solve command with a timeout and never throws", async () => {
    const { page, detach } = cdpPage({ hangs: true });

    const verdict = await solveAwCaptchaOnce(page as never, 50);

    expect(verdict.solved).toBe(false);
    expect(verdict.detail).toContain("timeout");
    expect(detach).toHaveBeenCalled();
  });

  it("degrades to a diagnostic when the CDP session is unavailable", async () => {
    const page = {};

    const verdict = await solveAwCaptchaOnce(page as never, 1_000);

    expect(verdict.solved).toBe(false);
    expect(verdict.detail).toContain("cdp_unavailable");
  });
});

describe("waitForCaptchaIfPresent diagnostics", () => {
  it("logs detection then solved, with exactly one solve command", async () => {
    const budget = new AwCaptchaSolveBudget();
    const { logger, events } = captureLogger();
    const { page, cdpSend } = fakeChoixDcePage({
      captcha: { present: true, solves: true },
      cdpResult: { solved: true },
    });

    await waitForCaptchaIfPresent(page as never, 1_000, budget, logger);

    expect(cdpSend).toHaveBeenCalledTimes(1);
    expect(events.map(({ event }) => event)).toEqual([
      "recovery_aw_captcha_detected",
      "recovery_aw_captcha_solved",
    ]);
    expect(events[0]?.record).toMatchObject({ wall: "aw_image_captcha" });
  });

  it("logs an unsolved CAPTCHA with the solver verdict and fails with detail", async () => {
    const budget = new AwCaptchaSolveBudget();
    const { logger, events } = captureLogger();
    const { page } = fakeChoixDcePage({
      captcha: { present: true, solves: false },
      cdpResult: { found: false, solved: false },
    });

    const error = await waitForCaptchaIfPresent(
      page as never,
      1_000,
      budget,
      logger,
    ).catch((caught: unknown) => caught as AwAdapterError);

    expect(error).toMatchObject({ reasonCode: "CAPTCHA_UNSOLVED" });
    expect(String((error as Error).message)).toContain(
      "captcha_not_recognized_by_browserless",
    );
    expect(events.map(({ event }) => event)).toEqual([
      "recovery_aw_captcha_detected",
      "recovery_aw_captcha_unsolved",
    ]);
    expect(events[1]?.record).toMatchObject({
      detail: "captcha_not_recognized_by_browserless",
    });
  });

  it("logs an exhausted solve budget as unsolved before failing", async () => {
    const budget = new AwCaptchaSolveBudget();
    budget.commitSolve();
    const { logger, events } = captureLogger();
    const { page, cdpSend } = fakeChoixDcePage({
      captcha: { present: true, solves: true },
      cdpResult: { solved: true },
    });

    await expect(
      waitForCaptchaIfPresent(page as never, 1_000, budget, logger),
    ).rejects.toMatchObject({ reasonCode: "CAPTCHA_UNSOLVED" });
    expect(cdpSend).not.toHaveBeenCalled();
    expect(events.map(({ event }) => event)).toEqual([
      "recovery_aw_captcha_detected",
      "recovery_aw_captcha_unsolved",
    ]);
    expect(events[1]?.record).toMatchObject({
      detail: "solve_budget_exhausted",
    });
  });
});

describe("PlaywrightAwBrowserSession failure diagnostics", () => {
  it("names the failing step and keeps the original error text", async () => {
    const flow = fakeAwDiscoverFlow("avertissement");
    flow.browser.contexts()[0]!.pages()[0]!.goto.mockRejectedValueOnce(
      new Error("net::ERR_TIMED_OUT at https://example.test"),
    );
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(flow.browser as never);
    const session = new PlaywrightAwBrowserSession({
      browserlessToken: "fixture-token",
      awPortalEmail: "operator@example.test",
      awPortalPassword: "fixture-password",
      timeoutMs: 1_000,
    });

    const error = await session
      .discover({
        jobId: "fixture-job",
        tenderId: "fixture-tender",
        sourceField: "link_to_buyer_profile",
        providedUrl:
          "https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematEnt.login&type=DCE&IDM=1848459",
        requestedLots: { kind: "all" },
      })
      .catch((caught: unknown) => caught as AwAdapterError);

    expect(error).toMatchObject({
      reasonCode: "ADAPTER_FAILURE",
      retryable: true,
      failureStage: "navigation",
      failureType: "network",
    });
    expect(String((error as Error).message)).toContain("at goto");
    expect(String((error as Error).message)).toContain("net::ERR_TIMED_OUT");
  });
});
