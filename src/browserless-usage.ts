import { z } from "zod";

const USAGE_ENDPOINT = "https://api.browserless.io/v1/account/usage";
const DEFAULT_TIMEOUT_MS = 10_000;

const BrowserlessUsagePayloadSchema = z
  .object({
    units: z
      .object({
        used: z.number().finite().nonnegative(),
      })
      .passthrough(),
    billingPeriod: z
      .object({
        start: z.string().min(1),
        end: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

type Fetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface BrowserlessUsageSnapshot {
  unitsUsed: number;
  billingPeriodStart: string;
  billingPeriodEnd: string;
}

export interface BrowserlessUsageDelta {
  unitsBefore: number;
  unitsAfter: number;
  unitsConsumed: number;
  billingPeriodStart: string;
  billingPeriodEnd: string;
}

export interface BrowserlessUsageReader {
  snapshot(): Promise<BrowserlessUsageSnapshot>;
}

export interface BrowserlessUsageClientOptions {
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export class BrowserlessUsageError extends Error {
  constructor() {
    super("BROWSERLESS_USAGE_UNAVAILABLE");
    this.name = "BrowserlessUsageError";
  }
}

export class BrowserlessUsageClient implements BrowserlessUsageReader {
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    options: BrowserlessUsageClientOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async snapshot(): Promise<BrowserlessUsageSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const endpoint = new URL(USAGE_ENDPOINT);
      endpoint.searchParams.set("token", this.token);
      const response = await this.fetcher(endpoint, {
        signal: controller.signal,
      });
      if (!response.ok) throw new BrowserlessUsageError();
      const parsed = BrowserlessUsagePayloadSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) throw new BrowserlessUsageError();
      return {
        unitsUsed: parsed.data.units.used,
        billingPeriodStart: parsed.data.billingPeriod.start,
        billingPeriodEnd: parsed.data.billingPeriod.end,
      };
    } catch {
      throw new BrowserlessUsageError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function calculateBrowserlessUsageDelta(
  before: BrowserlessUsageSnapshot,
  after: BrowserlessUsageSnapshot,
): BrowserlessUsageDelta {
  if (
    before.billingPeriodStart !== after.billingPeriodStart ||
    before.billingPeriodEnd !== after.billingPeriodEnd ||
    after.unitsUsed < before.unitsUsed
  ) {
    throw new BrowserlessUsageError();
  }

  return {
    unitsBefore: before.unitsUsed,
    unitsAfter: after.unitsUsed,
    unitsConsumed: after.unitsUsed - before.unitsUsed,
    billingPeriodStart: before.billingPeriodStart,
    billingPeriodEnd: before.billingPeriodEnd,
  };
}
