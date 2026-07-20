import { describe, expect, it, vi } from "vitest";

import type { AwAdapterError } from "../src/adapters/aw-solutions.js";
import {
  AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_ATTEMPT,
  AW_CAPTCHA_SOLVE_UNIT_COST,
  AwCaptchaSolveBudget,
  authenticateAwIfPrompted,
  chooseDceCompletIfPrompted,
  clickChoixDceIdentificationIfPrompted,
  locateAwLotSelectionForm,
  waitForCaptchaIfPresent,
} from "../src/adapters/playwright-aw-session.js";

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
}) {
  const clicked: string[] = [];
  const waitForFunction = vi.fn(async () => {
    if (options.captcha?.solves !== true) throw new Error("fixture timeout");
  });
  const page = {
    locator: (selector: string) => ({
      first: () => ({
        count: async () =>
          selector === "#texteCaptcha" && options.captcha?.present ? 1 : 0,
        inputValue: async () => options.captcha?.value ?? "",
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
  return { page, clicked, waitForFunction };
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
      AW_CAPTCHA_SOLVE_UNIT_BUDGET_PER_ATTEMPT,
    );
  });
});
