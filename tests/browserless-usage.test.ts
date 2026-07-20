import { describe, expect, it, vi } from "vitest";

import {
  BrowserlessUsageClient,
  BrowserlessUsageError,
  calculateBrowserlessUsageDelta,
} from "../src/browserless-usage.js";

describe("BrowserlessUsageClient", () => {
  it("reads the official account usage payload", async () => {
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(
        JSON.stringify({
          plan: { name: "fixture" },
          units: { included: 1_000, used: 41, remaining: 959 },
          billingPeriod: {
            start: "2026-07-01T00:00:00.000Z",
            end: "2026-08-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const snapshot = await new BrowserlessUsageClient("fixture-token", {
      fetcher,
    }).snapshot();

    expect(snapshot).toEqual({
      unitsUsed: 41,
      billingPeriodStart: "2026-07-01T00:00:00.000Z",
      billingPeriodEnd: "2026-08-01T00:00:00.000Z",
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "https://api.browserless.io/v1/account/usage?token=fixture-token",
    );
  });

  it("fails with a generic error that never exposes the token", async () => {
    const token = "must-never-leak";
    const client = new BrowserlessUsageClient(token, {
      fetcher: vi.fn(async (input: string | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response("denied", { status: 401 });
      }),
    });

    const error = await client.snapshot().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserlessUsageError);
    expect(String(error)).not.toContain(token);
  });
});

describe("calculateBrowserlessUsageDelta", () => {
  const before = {
    unitsUsed: 41,
    billingPeriodStart: "2026-07-01T00:00:00.000Z",
    billingPeriodEnd: "2026-08-01T00:00:00.000Z",
  };

  it("reports the exact account-level delta in one billing period", () => {
    expect(
      calculateBrowserlessUsageDelta(before, {
        ...before,
        unitsUsed: 54,
      }),
    ).toEqual({
      unitsBefore: 41,
      unitsAfter: 54,
      unitsConsumed: 13,
      billingPeriodStart: before.billingPeriodStart,
      billingPeriodEnd: before.billingPeriodEnd,
    });
  });

  it("rejects a billing-period change or a regressing counter", () => {
    expect(() =>
      calculateBrowserlessUsageDelta(before, {
        ...before,
        billingPeriodStart: "2026-08-01T00:00:00.000Z",
      }),
    ).toThrow("BROWSERLESS_USAGE_UNAVAILABLE");
    expect(() =>
      calculateBrowserlessUsageDelta(before, {
        ...before,
        unitsUsed: 40,
      }),
    ).toThrow("BROWSERLESS_USAGE_UNAVAILABLE");
  });
});
