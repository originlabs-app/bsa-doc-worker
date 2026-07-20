import { describe, expect, it, vi } from "vitest";

import {
  createSupabaseLearningMemoryStore,
  embedText,
} from "../src/analyze/index.js";

describe("OpenRouter lesson embeddings", () => {
  it("requests the stable 768-dimension learning model", async () => {
    const embedding = Array.from({ length: 768 }, (_, index) => index / 1_000);
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ embedding }],
    }), { status: 200 }));

    await expect(embedText("AO test", "secret", fetchFn)).resolves.toEqual(embedding);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        body: JSON.stringify({
          model: "google/gemini-embedding-2",
          input: "AO test",
          dimensions: 768,
        }),
      }),
    );
  });
});

describe("Supabase learning memory adapter", () => {
  it("ports the recall and usage RPC contracts without writing during recall", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "match_ao_lessons") {
        return {
          data: [{
            id: "lesson-1",
            kind: "go",
            tender_ref: "AO-1",
            title: "AO gagné",
            lesson_text: "Raison: bon fit",
            decided_at: "2026-07-01T00:00:00.000Z",
            similarity: 0.91,
          }],
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const eqStatus = vi.fn().mockResolvedValue({
      data: [{
        id: "rule-1",
        title: "Règle",
        description: "Description",
        recommended_action: null,
        match_terms: ["test"],
        negative_terms: [],
        pattern_type: "preference",
        confidence: "high",
      }],
      error: null,
    });
    const client = {
      rpc,
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({ eq: eqStatus })),
          })),
        })),
      })),
    };
    const store = createSupabaseLearningMemoryStore(client);

    await expect(store.matchLessons({
      companyId: "company-1",
      embedding: "[0.1]",
      embeddingModel: "embedding-model",
      limit: 15,
    })).resolves.toEqual([
      expect.objectContaining({ id: "lesson-1", tenderRef: "AO-1" }),
    ]);
    await expect(store.listApprovedRules("company-1")).resolves.toEqual([
      expect.objectContaining({ id: "rule-1", matchTerms: ["test"] }),
    ]);
    expect(rpc).toHaveBeenCalledWith("match_ao_lessons", {
      p_company_id: "company-1",
      p_embedding: "[0.1]",
      p_embedding_model: "embedding-model",
      p_k: 15,
    });
    expect(rpc).not.toHaveBeenCalledWith(
      "record_scraping_memory_usage",
      expect.anything(),
    );

    await store.recordRuleUsage(["rule-1", "rule-1"]);
    expect(rpc).toHaveBeenCalledWith("record_scraping_memory_usage", {
      p_memory_ids: ["rule-1"],
    });
  });
});
