import { describe, expect, it, vi } from "vitest";

import {
  DOCUMENT_READER_ROLES,
  documentReaderSchemas,
} from "../src/llm/document-schemas.js";
import {
  readPdfWithLlm,
  type ReaderLlmInvalidOutputError,
  type StructuredPdfClient,
} from "../src/llm/document-reader.js";

describe("document reader schemas", () => {
  it("keeps all historical roles plus the unknown fallback", () => {
    expect(DOCUMENT_READER_ROLES).toEqual([
      "rc",
      "avis",
      "ccap",
      "ae",
      "cctp",
      "dpgf",
      "bpu",
      "dqe",
      "inconnu",
    ]);
  });

  it.each(DOCUMENT_READER_ROLES)("validates the compatible %s payload", (role) => {
    expect(
      documentReaderSchemas[role].parse({ texte: "Contenu utile", pages_lues: 3 }),
    ).toEqual({ texte: "Contenu utile", pages_lues: 3 });
    expect(() =>
      documentReaderSchemas[role].parse({ texte: 42, pages_lues: -1 }),
    ).toThrow();
  });
});

describe("readPdfWithLlm", () => {
  it("returns typed text and provider cost", async () => {
    const generate = vi.fn().mockResolvedValue({
      object: { texte: "Règlement lu", pages_lues: 8 },
      costUsd: 0.012,
    });
    const client: StructuredPdfClient = { generate };

    await expect(
      readPdfWithLlm(
        { bytes: new Uint8Array([37, 80, 68, 70]), fileName: "RC.pdf", role: "rc" },
        client,
      ),
    ).resolves.toEqual({
      text: "Règlement lu",
      pagesRead: 8,
      costUsd: 0.012,
      attempts: 1,
    });
  });

  it("retries one invalid object and aggregates both billed attempts", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ object: { texte: 42 }, costUsd: 0.004 })
      .mockResolvedValueOnce({
        object: { texte: "CCTP lu", pages_lues: 5 },
        costUsd: 0.006,
      });

    await expect(
      readPdfWithLlm(
        {
          bytes: new Uint8Array([37, 80, 68, 70]),
          fileName: "CCTP.pdf",
          role: "cctp",
        },
        { generate },
      ),
    ).resolves.toMatchObject({
      text: "CCTP lu",
      costUsd: 0.01,
      attempts: 2,
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("fails cleanly after the bounded invalid-output retry", async () => {
    const generate = vi.fn().mockResolvedValue({
      object: { pages_lues: "beaucoup" },
      costUsd: 0.003,
    });

    const promise = readPdfWithLlm(
      {
        bytes: new Uint8Array([37, 80, 68, 70]),
        fileName: "inconnu.pdf",
        role: "inconnu",
      },
      { generate },
    );

    await expect(promise).rejects.toMatchObject({
      name: "ReaderLlmInvalidOutputError",
      code: "READER_LLM_INVALID_OUTPUT",
      costUsd: 0.006,
    } satisfies Partial<ReaderLlmInvalidOutputError>);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
