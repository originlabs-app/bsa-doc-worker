import { describe, expect, it, vi } from "vitest";

import {
  runAnalyzeOneShot,
  type AnalysisWritePayload,
} from "../src/analyze/index.js";
import {
  createSupabaseAnalyzeStore,
  type AnalyzeSupabaseClient,
} from "../src/analyze/supabase.js";

interface QueryOperation {
  method: string;
  args: unknown[];
}

function queryResult(
  result: { data: unknown; error: unknown },
  operations: QueryOperation[],
) {
  const query = {
    select: (...args: unknown[]) => chain("select", args),
    or: (...args: unknown[]) => chain("or", args),
    lte: (...args: unknown[]) => chain("lte", args),
    order: (...args: unknown[]) => chain("order", args),
    limit: (...args: unknown[]) => chain("limit", args),
    eq: (...args: unknown[]) => chain("eq", args),
    is: (...args: unknown[]) => chain("is", args),
    not: (...args: unknown[]) => chain("not", args),
    update: (...args: unknown[]) => chain("update", args),
    maybeSingle: vi.fn(async () => result),
    then: (
      resolve: (value: { data: unknown; error: unknown }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  function chain(method: string, args: unknown[]) {
    operations.push({ method, args });
    return query;
  }
  return query;
}

function fixtureClient(input: {
  tender?: unknown;
  company?: unknown;
  qualifications?: unknown[];
  queue?: unknown[];
  documents?: unknown[];
  text?: string;
  downloadError?: unknown;
}) {
  const operations = new Map<string, QueryOperation[]>();
  const updates: Array<{ table: string; values: unknown }> = [];
  const from = vi.fn((table: string) => {
    const tableOperations = operations.get(table) ?? [];
    operations.set(table, tableOperations);
    const data = table === "tender"
      ? input.tender ?? null
      : table === "company"
      ? input.company ?? null
      : table === "mandatory_qualification"
      ? input.qualifications ?? []
      : table === "dce_analysis_queue"
      ? input.queue ?? []
      : [];
    const query = queryResult({ data, error: null }, tableOperations);
    const originalUpdate = query.update;
    query.update = (...args: unknown[]) => {
      updates.push({ table, values: args[0] });
      return originalUpdate(...args);
    };
    return query;
  });
  const rpc = vi.fn(async (name: string) => {
    if (name === "list_tender_analysis_documents") {
      return { data: input.documents ?? [], error: null };
    }
    if (name === "claim_dce_analysis_queue_row") {
      return { data: "claimed", error: null };
    }
    return { data: { ok: true }, error: null };
  });
  const download = vi.fn(async () => ({
    data: new Blob([input.text ?? "Texte extrait du CCTP"]),
    error: input.downloadError ?? null,
  }));
  const client = {
    from,
    rpc,
    storage: { from: vi.fn(() => ({ download })) },
  } as unknown as AnalyzeSupabaseClient;
  return { client, operations, rpc, download, updates };
}

const candidate = { queueId: "queue-1", tenderId: "tender-1", attempts: 1 };

const tender = {
  id: "tender-1",
  company_id: "company-1",
  title: "Marché de rénovation",
  buyer_name: "Ville test",
  summary_description: "Résumé métier",
  contract_subject: "Objet contractuel",
  project_location: null,
  city: "Paris",
  department_code: "75",
  estimated_value: "500000",
  procedure_type: "MAPA",
  relevance_score: "72",
  deleted_at: null,
  status: "opportunity",
  record_type: "market",
  parent_tender_id: null,
};

const company = {
  id: "company-1",
  name: "Entreprise test",
  core_business: "Rénovation",
  desired_contracts: "Marchés de bâtiments",
  code_naf: "4399C",
  search_keywords: ["rénovation"],
  exclusion_keywords: [],
  search_departments: ["75"],
  search_city: "Paris",
  search_radius_km: 50,
  search_market_types: ["travaux"],
  certifications_held: ["QUALIBAT"],
  certifications_excluded: [],
  accepts_social_insertion: true,
};

const document = {
  id: "doc-1",
  tender_id: "tender-1",
  file_name: "CCTP.pdf",
  url: "company-1/tender-1/CCTP.pdf",
  document_type: "dce",
  added_by: null,
  parent_document_id: null,
  analysis_role: "cctp",
  analysis_role_source: "filename",
  extraction_status: "extracted",
  dce_extraction_result: null,
  dce_extraction_model: null,
  dce_extraction_cost_usd: null,
  dce_extracted_at: "2026-07-20T18:00:00.000Z",
  dce_coverage_families: [],
  dce_clauses_verified: true,
  analysis_lot_number: "1",
};

describe("Supabase ANALYZE read adapter", () => {
  it("peeks in canonical order and assembles the typed READER dossier", async () => {
    const fixture = fixtureClient({
      tender,
      company,
      qualifications: [{
        code: "QUALIBAT",
        label: "Qualification bâtiment",
        derogeable: false,
        aliases: ["Qualibat"],
      }],
      queue: [{ id: "queue-1", tender_id: "tender-1", attempts: 1 }],
      documents: [document],
      text: "Travaux de rénovation du bâtiment communal.",
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(store.peekCandidates(
      10,
      "2026-07-20T20:00:00.000Z",
    )).resolves.toEqual([candidate]);
    await expect(store.assembleCandidate(candidate)).resolves.toMatchObject({
      status: "ready",
      assembly: {
        companyId: "company-1",
        existingScore: 72,
        dossier: {
          tender: {
            id: "tender-1",
            description: "Résumé métier",
            location: "Paris 75",
            estimatedAmount: 500_000,
          },
          company: { name: "Entreprise test" },
          mandatoryQualifications: [{ code: "QUALIBAT", derogeable: false }],
          documents: [{
            id: "doc-1",
            role: "cctp",
            lotNumber: "1",
            text: "Travaux de rénovation du bâtiment communal.",
          }],
        },
        coverage: {
          complete: true,
          documentsCount: 1,
          omittedDocuments: 0,
          totalCharacters: 43,
        },
      },
    });
    expect(fixture.operations.get("dce_analysis_queue")).toEqual(
      expect.arrayContaining([
        { method: "or", args: ["status.eq.pending,and(status.eq.failed,attempts.lt.3)"] },
        { method: "order", args: ["queue_order_at", { ascending: true }] },
        { method: "order", args: ["created_at", { ascending: true }] },
        { method: "order", args: ["id", { ascending: true }] },
      ]),
    );
    expect(fixture.rpc).toHaveBeenCalledWith("list_tender_analysis_documents", {
      _tender_id: "tender-1",
    });
    expect(fixture.download).toHaveBeenCalledWith(
      "company-1/tender-1/dce-text/doc-1.txt",
    );
  });

  it("refuses partial analysis while a relevant document is still extracting", async () => {
    const fixture = fixtureClient({
      tender,
      company,
      documents: [{ ...document, extraction_status: "oversized_document" }],
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(store.assembleCandidate(candidate)).resolves.toEqual({
      status: "not_ready",
      reason: "ANALYZE_DOCUMENTS_NOT_READY",
    });
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it("reports partial coverage only for terminal unread documents", async () => {
    const fixture = fixtureClient({
      tender,
      company,
      documents: [
        document,
        {
          ...document,
          id: "doc-2",
          file_name: "Annexe.pdf",
          extraction_status: "unsupported_format",
        },
      ],
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(store.assembleCandidate(candidate)).resolves.toMatchObject({
      status: "ready",
      assembly: {
        coverage: {
          complete: false,
          documentsCount: 1,
          omittedDocuments: 1,
        },
      },
    });
  });

  it("fails closed when an expected extracted text object is empty", async () => {
    const fixture = fixtureClient({
      tender,
      company,
      documents: [document],
      text: "   ",
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(store.assembleCandidate(candidate)).rejects.toThrow(
      "ANALYZE_DOCUMENT_TEXT_EMPTY",
    );
  });

  it("replaces external Storage errors with a short non-sensitive issue", async () => {
    const fixture = fixtureClient({
      tender,
      company,
      documents: [document],
      downloadError: new Error("https://signed.example/private?token=secret"),
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(store.assembleCandidate(candidate)).rejects.toThrow(
      "ANALYZE_DOCUMENT_TEXT_READ_FAILED",
    );
  });
});

describe("Supabase ANALYZE apply contract", () => {
  it("uses the local claim RPC and existing guarded tender/lot/ledger contracts", async () => {
    const fixture = fixtureClient({ tender, company });
    const store = createSupabaseAnalyzeStore(fixture.client);
    const payload: AnalysisWritePayload = {
      tenderId: "tender-1",
      tenderValues: { relevance_score: 100, relevance_reason: "Excellent fit" },
      lots: [{
        number: "1",
        title: "Rénovation",
        relevanceScore: 100,
        relevanceReason: "Excellent fit",
        verdict: "recommended",
        forcedZero: false,
        summary: {
          scope: "Rénovation",
          services: [],
          requirements: [],
          qualifications: [],
          amounts: [],
          watchpoints: [],
        },
      }],
      ledger: {
        tenderId: "tender-1",
        step: "dce_scoring",
        model: "openai/gpt-5.6-terra",
        costUsd: 0.03,
        metadata: { forced_zero: false },
      },
    };

    await expect(store.claim("queue-1")).resolves.toBe("claimed");
    await store.createResultSink({
      queue: candidate,
      companyId: "company-1",
      recordType: "market",
      existingScore: 72,
      dossier: {
        tender: {
          id: "tender-1",
          title: "Marché",
          buyerName: null,
          description: null,
          location: null,
          estimatedAmount: null,
          procedureType: null,
        },
        company: {},
        mandatoryQualifications: [],
        documents: [],
      },
      coverage: {
        complete: true,
        documentsCount: 1,
        omittedDocuments: 0,
        totalCharacters: 10,
      },
    }).write(payload);
    await store.markDone("queue-1", "2026-07-20T20:00:00.000Z");

    expect(fixture.rpc).toHaveBeenCalledWith("claim_dce_analysis_queue_row", {
      p_queue_id: "queue-1",
    });
    expect(fixture.rpc).toHaveBeenCalledWith("sync_tender_lot_analysis", {
      p_parent_tender_id: "tender-1",
      p_analysis_state: "documentary_complete",
      p_lots: [expect.objectContaining({
        source_lot_key: "number:1",
        lot_number: "1",
        relevance_score: 100,
        lot_fit_status: "recommended",
      })],
      p_run_evidence: expect.objectContaining({ queue_id: "queue-1" }),
    });
    expect(fixture.rpc).toHaveBeenCalledWith("record_ai_spend", {
      p_tender_id: "tender-1",
      p_step: "dce_scoring",
      p_model: "openai/gpt-5.6-terra",
      p_cost_usd: 0.03,
      p_metadata: { forced_zero: false },
    });
    expect(fixture.updates).toEqual(expect.arrayContaining([
      { table: "tender", values: expect.objectContaining({ relevance_score: 100 }) },
      { table: "dce_analysis_queue", values: expect.objectContaining({ status: "done" }) },
    ]));
  });

  it("does not call the market-parent lot sync for a direct lot analysis", async () => {
    const fixture = fixtureClient({ tender, company });
    const store = createSupabaseAnalyzeStore(fixture.client);
    await store.createResultSink({
      queue: candidate,
      companyId: "company-1",
      recordType: "lot",
      existingScore: 72,
      dossier: {
        tender: {
          id: "tender-1",
          title: "Lot 1",
          buyerName: null,
          description: null,
          location: null,
          estimatedAmount: null,
          procedureType: null,
        },
        company: {},
        mandatoryQualifications: [],
        documents: [],
      },
      coverage: {
        complete: true,
        documentsCount: 1,
        omittedDocuments: 0,
        totalCharacters: 10,
      },
    }).write({
      tenderId: "tender-1",
      tenderValues: { relevance_score: 80 },
      lots: [{
        number: "1",
        title: "Lot direct",
        relevanceScore: 80,
        relevanceReason: "Fit",
        verdict: "recommended",
        forcedZero: false,
        summary: {
          scope: "Lot",
          services: [],
          requirements: [],
          qualifications: [],
          amounts: [],
          watchpoints: [],
        },
      }],
      ledger: {
        tenderId: "tender-1",
        step: "dce_scoring",
        model: "model",
        costUsd: 0.01,
        metadata: {},
      },
    });

    expect(fixture.rpc).not.toHaveBeenCalledWith(
      "sync_tender_lot_analysis",
      expect.anything(),
    );
    expect(fixture.rpc).toHaveBeenCalledWith(
      "record_ai_spend",
      expect.anything(),
    );
  });
});

describe("Supabase ANALYZE shadow integration", () => {
  it("produces a comparison without any client-side write", async () => {
    const fixture = fixtureClient({
      tender,
      company,
      queue: [{ id: "queue-1", tender_id: "tender-1", attempts: 1 }],
      documents: [document],
    });
    const store = createSupabaseAnalyzeStore(fixture.client);
    const logger = { info: vi.fn() };

    const report = await runAnalyzeOneShot({
      mode: "shadow",
      model: "openai/gpt-5.6-terra",
      maxSteps: 8,
      maxOutputTokens: 8_192,
      openRouterApiKey: "test",
    }, {
      readStore: store,
      applyStore: store,
      client: {
        generate: vi.fn().mockResolvedValue({
          output: {
            marketSummary: "Marché adapté.",
            units: [{
              unit: { kind: "lot", number: "1", title: "Rénovation" },
              proposedVerdict: "favorable",
              rationale: "Le besoin correspond au métier.",
              criteria: {
                metier: 30,
                geo: 20,
                montant: 20,
                procedure: 15,
                certifications: 0,
              },
              unknownCriteria: ["certifications"],
              summary: {
                scope: "Rénovation du bâtiment.",
                services: ["Travaux"],
                requirements: [],
                qualifications: [],
                amounts: ["500 000 euros"],
                watchpoints: [],
              },
              requiredQualifications: [],
              socialInsertion: null,
              citations: [{ documentId: "doc-1", excerpt: "Texte extrait" }],
            }],
          },
          stepsUsed: 2,
          costUsd: 0.02,
          usage: { inputTokens: 800, outputTokens: 300, totalTokens: 1_100 },
        }),
      },
      recallLearning: vi.fn().mockResolvedValue({
        lessons: [],
        rules: [],
        context: "",
      }),
      logger,
    }, { now: () => new Date("2026-07-20T20:00:00.000Z") });

    expect(report).toMatchObject({
      mode: "shadow",
      status: "analyzed",
      existingScore: 72,
      analyzedScore: 100,
      delta: 28,
    });
    expect(fixture.updates).toEqual([]);
    expect(fixture.rpc.mock.calls.map(([name]) => name)).toEqual([
      "list_tender_analysis_documents",
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_shadow_comparison",
      expect.objectContaining({ delta: 28 }),
    );
  });
});
