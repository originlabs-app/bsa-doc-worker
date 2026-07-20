import { describe, expect, it, vi } from "vitest";

import type { AwAdapterError } from "../src/adapters/aw-solutions.js";
import { authenticateAwIfPrompted } from "../src/adapters/playwright-aw-session.js";

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
