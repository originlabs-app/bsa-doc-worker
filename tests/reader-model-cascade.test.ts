import { describe, expect, it, vi } from "vitest";

import {
  ReaderLlmProviderError,
  SdkStructuredOutputError,
  type StructuredPdfClient,
} from "../src/llm/document-reader.js";
import {
  compareReaderPayloads,
  generateAuditPayload,
  isAuditSampled,
  readPdfWithModelCascade,
} from "../src/reader/model-cascade.js";

const input = {
  bytes: new Uint8Array([1, 2, 3]),
  fileName: "RC.pdf",
  role: "rc" as const,
};

function validClient(text = "Texte lu", costUsd = 0.001): StructuredPdfClient {
  return {
    generate: vi.fn(async () => ({
      object: { texte: text, pages_lues: 3 },
      costUsd,
    })),
  };
}

function invalidClient(costUsd = 0.002): StructuredPdfClient {
  return {
    generate: vi.fn(async () => ({
      object: { texte: 42, pages_lues: "invalid" },
      costUsd,
    })),
  };
}

describe("readPdfWithModelCascade", () => {
  it("returns the primary result without touching the fallback when the schema passes", async () => {
    const primary = validClient();
    const fallback = validClient("Secours");

    const result = await readPdfWithModelCascade(input, { primary, fallback });

    expect(result).toMatchObject({
      text: "Texte lu",
      pagesRead: 3,
      costUsd: 0.001,
      primaryCostUsd: 0.001,
      fallbackCostUsd: 0,
      attempts: 1,
      zodAttempts: 0,
      fallbackUsed: false,
    });
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it("calls the fallback exactly once after exactly two zod failures", async () => {
    const primary = invalidClient(0.002);
    const fallback = validClient("Sauvé par le secours", 0.01);

    const result = await readPdfWithModelCascade(input, { primary, fallback });

    expect(primary.generate).toHaveBeenCalledTimes(2);
    expect(fallback.generate).toHaveBeenCalledTimes(1);
    expect(fallback.generate).toHaveBeenCalledWith(
      expect.objectContaining({ repair: true }),
    );
    expect(result).toMatchObject({
      text: "Sauvé par le secours",
      costUsd: expect.closeTo(0.014, 9) as number,
      primaryCostUsd: expect.closeTo(0.004, 9) as number,
      fallbackCostUsd: 0.01,
      attempts: 3,
      zodAttempts: 2,
      fallbackUsed: true,
    });
  });

  it("fails the piece with the summed cost when the fallback also violates the schema", async () => {
    const primary = invalidClient(0.002);
    const fallback = invalidClient(0.01);

    await expect(
      readPdfWithModelCascade(input, { primary, fallback }),
    ).rejects.toMatchObject({
      code: "READER_LLM_INVALID_OUTPUT",
      // 2 x 0.002 (titulaire) + 0.01 (secours facturé malgré la sortie invalide)
      costUsd: expect.closeTo(0.014, 9) as number,
    });
    expect(fallback.generate).toHaveBeenCalledTimes(1);
  });

  it("keeps today's behaviour when no fallback client is configured", async () => {
    const primary = invalidClient(0.003);

    await expect(
      readPdfWithModelCascade(input, { primary }),
    ).rejects.toMatchObject({
      code: "READER_LLM_INVALID_OUTPUT",
      costUsd: expect.closeTo(0.006, 9) as number,
    });
    expect(primary.generate).toHaveBeenCalledTimes(2);
  });

  it("propagates a provider failure without trying the fallback", async () => {
    const primary: StructuredPdfClient = {
      generate: vi.fn(async () => {
        throw new ReaderLlmProviderError(0.004);
      }),
    };
    const fallback = validClient();

    await expect(
      readPdfWithModelCascade(input, { primary, fallback }),
    ).rejects.toMatchObject({
      code: "READER_LLM_PROVIDER_FAILED",
      costUsd: 0.004,
    });
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it("accumulates the SDK schema-failure cost billed on each attempt", async () => {
    const primary: StructuredPdfClient = {
      generate: vi.fn(async () => {
        throw new SdkStructuredOutputError(0.005);
      }),
    };
    const fallback = validClient("Secours", 0.02);

    const result = await readPdfWithModelCascade(input, { primary, fallback });

    expect(result).toMatchObject({
      costUsd: expect.closeTo(0.03, 9) as number,
      primaryCostUsd: expect.closeTo(0.01, 9) as number,
      fallbackCostUsd: 0.02,
      fallbackUsed: true,
      zodAttempts: 2,
    });
  });
});

describe("generateAuditPayload", () => {
  it("returns the parsed payload and its cost on success", async () => {
    await expect(
      generateAuditPayload(input, validClient("Audit", 0.007)),
    ).resolves.toEqual({
      payload: { texte: "Audit", pages_lues: 3 },
      costUsd: 0.007,
    });
  });

  it("never throws: invalid output and provider failures return a null payload", async () => {
    await expect(
      generateAuditPayload(input, invalidClient(0.004)),
    ).resolves.toEqual({ payload: null, costUsd: 0.004 });
    await expect(
      generateAuditPayload(input, {
        generate: async () => {
          throw new ReaderLlmProviderError(0.002);
        },
      }),
    ).resolves.toEqual({ payload: null, costUsd: 0.002 });
  });
});

describe("compareReaderPayloads", () => {
  it("agrees on whitespace-only text differences", () => {
    expect(
      compareReaderPayloads(
        { texte: "Un  texte\nlu", pages_lues: 2 },
        { texte: "Un texte lu", pages_lues: 2 },
      ),
    ).toEqual([]);
  });

  it("lists each differing field", () => {
    expect(
      compareReaderPayloads(
        { texte: "Un texte", pages_lues: 2 },
        { texte: "Un autre texte", pages_lues: 3 },
      ),
    ).toEqual(["texte", "pages_lues"]);
  });
});

describe("isAuditSampled", () => {
  it("is deterministic and honours the boundary percents", () => {
    expect(isAuditSampled("document-1", 0)).toBe(false);
    expect(isAuditSampled("document-1", 100)).toBe(true);
    // Buckets SHA-256 connus : document-44 -> 4 (échantillonné à 5 %),
    // document-1 -> 5 (juste au-dessus du seuil, jamais échantillonné à 5 %).
    for (let index = 0; index < 5; index += 1) {
      expect(isAuditSampled("document-44", 5)).toBe(true);
      expect(isAuditSampled("document-1", 5)).toBe(false);
    }
  });

  it("selects close to the requested share of documents", () => {
    const total = 2_000;
    let sampled = 0;
    for (let index = 0; index < total; index += 1) {
      if (isAuditSampled(`document-${index}`, 5)) sampled += 1;
    }
    expect(sampled / total).toBeGreaterThan(0.02);
    expect(sampled / total).toBeLessThan(0.09);
  });
});
