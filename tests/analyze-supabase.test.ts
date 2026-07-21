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

function valueAtPath(row: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (parent, key) =>
      parent && typeof parent === "object"
        ? (parent as Record<string, unknown>)[key]
        : undefined,
    row,
  );
}

function queryResult(
  result: { data: unknown; error: unknown },
  operations: QueryOperation[],
) {
  let current = result;
  const query = {
    select: (...args: unknown[]) => chain("select", args),
    // Mirrors the PostgREST semantics of .in() on an !inner embedded column:
    // rows whose embedded value is outside the list are filtered server-side.
    in: (...args: unknown[]) => {
      const [column, values] = args as [string, unknown[]];
      if (Array.isArray(current.data)) {
        current = {
          ...current,
          data: current.data.filter((row) =>
            values.includes(valueAtPath(row, column))
          ),
        };
      }
      return chain("in", args);
    },
    or: (...args: unknown[]) => chain("or", args),
    lte: (...args: unknown[]) => chain("lte", args),
    order: (...args: unknown[]) => chain("order", args),
    limit: (...args: unknown[]) => chain("limit", args),
    eq: (...args: unknown[]) => chain("eq", args),
    is: (...args: unknown[]) => chain("is", args),
    not: (...args: unknown[]) => chain("not", args),
    filter: (...args: unknown[]) => chain("filter", args),
    update: (...args: unknown[]) => chain("update", args),
    maybeSingle: vi.fn(async () => current),
    then: (
      resolve: (value: { data: unknown; error: unknown }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(current).then(resolve, reject),
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
  rpcErrors?: Record<string, unknown>;
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
    if (input.rpcErrors && name in input.rpcErrors) {
      return { data: null, error: input.rpcErrors[name] };
    }
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
  deadline_date: "2026-09-30",
  submission_date: null,
  relevance_score: "72",
  deleted_at: null,
  status: "opportunity",
  record_type: "market",
  parent_tender_id: null,
  lot_number: null,
  lot_title: null,
  source_lot_key: null,
  lot_analysis_state: null,
  source: "Nukema API",
  lot_structure_mode: "multi",
  lot_structure_origin: "nukema_bot",
  lot_structure_locked_at: null,
};

const lotTender = {
  ...tender,
  id: "lot-1",
  title: "Lot 1 — Gros œuvre",
  record_type: "lot",
  parent_tender_id: "parent-1",
  lot_number: "1",
  lot_title: "Gros œuvre",
  source_lot_key: "boamp:lot-1",
  lot_analysis_state: "metadata_only",
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
      queue: [{
        id: "queue-1",
        tender_id: "tender-1",
        attempts: 1,
        tender: { record_type: "standalone" },
      }],
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
        deadlineDate: "2026-09-30",
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
        {
          method: "select",
          args: ["id,tender_id,attempts,tender!tender_id!inner(record_type)"],
        },
        { method: "in", args: ["tender.record_type", ["standalone"]] },
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

  it("ignores market and lot candidates outside the default standalone perimeter", async () => {
    const fixture = fixtureClient({
      queue: [
        {
          id: "queue-1",
          tender_id: "tender-1",
          attempts: 0,
          tender: { record_type: "standalone" },
        },
        {
          id: "queue-2",
          tender_id: "tender-2",
          attempts: 0,
          tender: { record_type: "market" },
        },
        {
          id: "queue-3",
          tender_id: "tender-3",
          attempts: 0,
          tender: { record_type: "lot" },
        },
      ],
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(store.peekCandidates(
      10,
      "2026-07-21T08:00:00.000Z",
    )).resolves.toEqual([
      { queueId: "queue-1", tenderId: "tender-1", attempts: 0 },
    ]);
    expect(fixture.operations.get("dce_analysis_queue")).toEqual(
      expect.arrayContaining([
        { method: "in", args: ["tender.record_type", ["standalone"]] },
      ]),
    );
  });

  it("widens the candidate perimeter to the configured record types", async () => {
    const fixture = fixtureClient({
      queue: [
        {
          id: "queue-1",
          tender_id: "tender-1",
          attempts: 0,
          tender: { record_type: "standalone" },
        },
        {
          id: "queue-2",
          tender_id: "tender-2",
          attempts: 0,
          tender: { record_type: "market" },
        },
        {
          id: "queue-3",
          tender_id: "tender-3",
          attempts: 0,
          tender: { record_type: "lot" },
        },
      ],
    });
    const store = createSupabaseAnalyzeStore(fixture.client, {
      recordTypes: ["market", "lot"],
    });

    await expect(store.peekCandidates(
      10,
      "2026-07-21T08:00:00.000Z",
    )).resolves.toEqual([
      { queueId: "queue-2", tenderId: "tender-2", attempts: 0 },
      { queueId: "queue-3", tenderId: "tender-3", attempts: 0 },
    ]);
    expect(fixture.operations.get("dce_analysis_queue")).toEqual(
      expect.arrayContaining([
        { method: "in", args: ["tender.record_type", ["market", "lot"]] },
      ]),
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
        sourceLotKey: null,
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
        businessFields: null,
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
      lot: null,
      autoMaterializeLots: false,
      existingScore: 72,
      deadlineDate: null,
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
      {
        table: "tender",
        values: expect.objectContaining({
          relevance_score: 100,
          analysis_state: "completed",
        }),
      },
      { table: "dce_analysis_queue", values: expect.objectContaining({ status: "done" }) },
    ]));
    expect(fixture.operations.get("tender")).toEqual(expect.arrayContaining([
      {
        method: "filter",
        args: ["lot_analysis_state", "isdistinct", "human_validated"],
      },
    ]));
  });

  function directLotAssembly(sourceLotKey: string | null) {
    return {
      queue: { queueId: "queue-1", tenderId: "lot-1", attempts: 1 },
      companyId: "company-1",
      recordType: "lot",
      lot: {
        parentTenderId: "parent-1",
        number: "1",
        title: "Gros œuvre",
        sourceLotKey,
      },
      autoMaterializeLots: false,
      existingScore: 72,
      deadlineDate: null,
      dossier: {
        tender: {
          id: "lot-1",
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
    };
  }

  function directLotPayload(sourceLotKey: string | null): AnalysisWritePayload {
    return {
      tenderId: "lot-1",
      tenderValues: { need_description: "Lot direct" },
      lots: [{
        sourceLotKey,
        number: "1",
        title: "Gros œuvre",
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
        businessFields: null,
      }],
      ledger: {
        tenderId: "lot-1",
        step: "dce_scoring",
        model: "model",
        costUsd: 0.01,
        metadata: {},
      },
    };
  }

  it("syncs a direct lot through its market parent with the DB source key", async () => {
    const fixture = fixtureClient({ tender: lotTender, company });
    const store = createSupabaseAnalyzeStore(fixture.client);
    await store.createResultSink(directLotAssembly("boamp:lot-1"))
      .write(directLotPayload("boamp:lot-1"));

    expect(fixture.rpc).toHaveBeenCalledWith("sync_tender_lot_analysis", {
      p_parent_tender_id: "parent-1",
      p_analysis_state: "documentary_complete",
      p_lots: [expect.objectContaining({
        source_lot_key: "boamp:lot-1",
        lot_number: "1",
        lot_title: "Gros œuvre",
        relevance_score: 80,
        lot_fit_status: "recommended",
      })],
      p_run_evidence: expect.objectContaining({ queue_id: "queue-1" }),
    });
    expect(fixture.rpc).toHaveBeenCalledWith(
      "record_ai_spend",
      expect.anything(),
    );
    const tenderUpdate = fixture.updates.find((entry) => entry.table === "tender");
    expect(tenderUpdate?.values).toEqual({ need_description: "Lot direct" });
    expect(tenderUpdate?.values).not.toHaveProperty("analysis_state");
    expect(tenderUpdate?.values).not.toHaveProperty("relevance_score");
  });

  it("falls back to the number-based lot key when the DB key is absent", async () => {
    const fixture = fixtureClient({
      tender: { ...lotTender, source_lot_key: null },
      company,
    });
    const store = createSupabaseAnalyzeStore(fixture.client);
    await store.createResultSink(directLotAssembly(null))
      .write(directLotPayload(null));

    expect(fixture.rpc).toHaveBeenCalledWith(
      "sync_tender_lot_analysis",
      expect.objectContaining({
        p_parent_tender_id: "parent-1",
        p_lots: [expect.objectContaining({ source_lot_key: "number:1" })],
      }),
    );
  });
});

describe("Supabase ANALYZE direct lot assembly", () => {
  it("assembles a direct lot with its parent context and target lot", async () => {
    const fixture = fixtureClient({
      tender: lotTender,
      company,
      documents: [{ ...document, tender_id: "lot-1" }],
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(store.assembleCandidate({
      queueId: "queue-1",
      tenderId: "lot-1",
      attempts: 0,
    })).resolves.toMatchObject({
      status: "ready",
      assembly: {
        recordType: "lot",
        lot: {
          parentTenderId: "parent-1",
          number: "1",
          title: "Gros œuvre",
          sourceLotKey: "boamp:lot-1",
        },
        dossier: {
          targetLot: { number: "1", title: "Gros œuvre" },
        },
      },
    });
  });

  it("skips a human-validated lot without reading its documents", async () => {
    const fixture = fixtureClient({
      tender: { ...lotTender, lot_analysis_state: "human_validated" },
      company,
      documents: [document],
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(store.assembleCandidate({
      queueId: "queue-1",
      tenderId: "lot-1",
      attempts: 0,
    })).resolves.toEqual({ status: "skipped", reason: "lot_human_validated" });
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it("skips an orphan lot without a market parent", async () => {
    const fixture = fixtureClient({
      tender: { ...lotTender, parent_tender_id: null },
      company,
      documents: [document],
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(store.assembleCandidate({
      queueId: "queue-1",
      tenderId: "lot-1",
      attempts: 0,
    })).resolves.toEqual({ status: "skipped", reason: "lot_orphan" });
    expect(fixture.download).not.toHaveBeenCalled();
  });
});

describe("Supabase ANALYZE shadow integration", () => {
  it("produces a comparison without any client-side write", async () => {
    const fixture = fixtureClient({
      tender,
      company,
      queue: [{
        id: "queue-1",
        tender_id: "tender-1",
        attempts: 1,
        tender: { record_type: "market" },
      }],
      documents: [document],
    });
    // The perimeter gate applies in shadow too: the market fixture is only
    // visible because the store is explicitly configured for market records.
    const store = createSupabaseAnalyzeStore(fixture.client, {
      recordTypes: ["market"],
    });
    const logger = { info: vi.fn() };

    const report = await runAnalyzeOneShot({
      mode: "shadow",
      model: "openai/gpt-5.6-terra",
      maxSteps: 8,
      maxOutputTokens: 8_192,
      deadlineMinDays: 15,
      recordTypes: ["market"],
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
              businessFields: null,
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

  it("falls back on submission_date and applies the DLRO cap", async () => {
    const fixture = fixtureClient({
      tender: {
        ...tender,
        deadline_date: null,
        submission_date: "2026-07-25",
      },
      company,
      queue: [{
        id: "queue-1",
        tender_id: "tender-1",
        attempts: 1,
        tender: { record_type: "standalone" },
      }],
      documents: [document],
    });
    const store = createSupabaseAnalyzeStore(fixture.client);
    const logger = { info: vi.fn() };

    const assembled = await store.assembleCandidate(candidate);
    expect(assembled).toMatchObject({
      status: "ready",
      assembly: { deadlineDate: "2026-07-25" },
    });

    const report = await runAnalyzeOneShot({
      mode: "shadow",
      model: "openai/gpt-5.6-terra",
      maxSteps: 8,
      maxOutputTokens: 8_192,
      deadlineMinDays: 15,
      recordTypes: ["standalone"],
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
              businessFields: null,
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
      analyzedScore: 40,
    });
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_shadow_comparison",
      expect.objectContaining({ shadow_score: 40, deadline_gate: "applied" }),
    );
  });
});

describe("Supabase ANALYZE lot materialization (LOT C)", () => {
  const businessFields = {
    summaryDescription: {
      value: "Travaux de gros œuvre",
      citation: "Le lot 1 comprend les travaux de gros œuvre",
    },
    contractDuration: {
      value: "12 mois",
      citation: "Durée du marché : 12 mois",
    },
    workStartDate: {
      value: "2026-09-01",
      citation: "Démarrage prévu le 1er septembre 2026",
    },
    estimatedValue: {
      value: 250_000,
      citation: "Montant estimé : 250 000 € HT",
    },
  };

  function marketAssembly(autoMaterializeLots: boolean) {
    return {
      queue: candidate,
      companyId: "company-1",
      recordType: "market",
      lot: null,
      autoMaterializeLots,
      existingScore: 72,
      deadlineDate: null,
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
    };
  }

  function marketPayload(
    fields: typeof businessFields | null,
  ): AnalysisWritePayload {
    return {
      tenderId: "tender-1",
      tenderValues: { relevance_score: 100 },
      lots: [{
        sourceLotKey: null,
        number: "1",
        title: "Gros œuvre",
        relevanceScore: 100,
        relevanceReason: "Excellent fit",
        verdict: "recommended",
        forcedZero: false,
        summary: {
          scope: "Gros œuvre",
          services: [],
          requirements: [],
          qualifications: [],
          amounts: [],
          watchpoints: [],
        },
        businessFields: fields,
      }],
      ledger: {
        tenderId: "tender-1",
        step: "dce_scoring",
        model: "model",
        costUsd: 0.01,
        metadata: {},
      },
    };
  }

  function rpcCall(
    fixture: ReturnType<typeof fixtureClient>,
    name: string,
  ): Record<string, unknown> | undefined {
    const calls = fixture.rpc.mock.calls as unknown as Array<
      [string, Record<string, unknown> | undefined]
    >;
    return calls.find(([called]) => called === name)?.[1];
  }

  it("materializes an eligible market mother before syncing its lots", async () => {
    const fixture = fixtureClient({ tender, company });
    const store = createSupabaseAnalyzeStore(fixture.client);
    await store.createResultSink(marketAssembly(true))
      .write(marketPayload(businessFields));

    const names = fixture.rpc.mock.calls.map(([name]) => name);
    expect(names.indexOf("materialize_tender_lots")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("materialize_tender_lots"))
      .toBeLessThan(names.indexOf("sync_tender_lot_analysis"));

    const materialize = rpcCall(fixture, "materialize_tender_lots");
    expect(materialize).toMatchObject({
      p_parent_tender_id: "tender-1",
      p_analysis_state: "documentary_complete",
      p_extraction_source: "dce",
      p_extractor_version: "analyze-dce-lots-v1",
      p_run_evidence: expect.objectContaining({ queue_id: "queue-1" }),
    });
    expect(materialize?.p_input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(materialize?.p_lots).toEqual([expect.objectContaining({
      source_lot_key: "number:1",
      lot_number: "1",
      lot_title: "Gros œuvre",
      lot_order: 0,
      lot_fit_status: "recommended",
    })]);
    // The sync receives the exact same canonical lot payload.
    expect(rpcCall(fixture, "sync_tender_lot_analysis")?.p_lots)
      .toEqual(materialize?.p_lots);
  });

  it("writes the four cited business fields with presence-based evidence", async () => {
    const fixture = fixtureClient({ tender, company });
    const store = createSupabaseAnalyzeStore(fixture.client);
    await store.createResultSink(marketAssembly(true))
      .write(marketPayload(businessFields));

    const [lot] = rpcCall(fixture, "sync_tender_lot_analysis")
      ?.p_lots as Array<Record<string, unknown>>;
    expect(lot).toMatchObject({
      summary_description: "Travaux de gros œuvre",
      contract_duration: "12 mois",
      work_start_date: "2026-09-01",
      estimated_value: 250_000,
      evidence: {
        business_fields: {
          description_prestations: {
            citation: "Le lot 1 comprend les travaux de gros œuvre",
          },
          duree_marche: { citation: "Durée du marché : 12 mois" },
          date_execution: { citation: "Démarrage prévu le 1er septembre 2026" },
          montant: { citation: "Montant estimé : 250 000 € HT" },
        },
      },
    });
  });

  it("omits every business key when the lot carries no business fields", async () => {
    const fixture = fixtureClient({ tender, company });
    const store = createSupabaseAnalyzeStore(fixture.client);
    await store.createResultSink(marketAssembly(true))
      .write(marketPayload(null));

    const [lot] = rpcCall(fixture, "sync_tender_lot_analysis")
      ?.p_lots as Array<Record<string, unknown>>;
    expect(lot).not.toHaveProperty("summary_description");
    expect(lot).not.toHaveProperty("contract_duration");
    expect(lot).not.toHaveProperty("work_start_date");
    expect(lot).not.toHaveProperty("estimated_value");
    expect(lot).not.toHaveProperty("evidence");
  });

  it("degrades every invalid business field to an absent key, never a 23514", async () => {
    const fixture = fixtureClient({ tender, company });
    const store = createSupabaseAnalyzeStore(fixture.client);
    await store.createResultSink(marketAssembly(true)).write(marketPayload({
      summaryDescription: businessFields.summaryDescription,
      contractDuration: { value: "12 mois", citation: "   " },
      workStartDate: { value: "01/09/2026", citation: "Démarrage" },
      estimatedValue: { value: -5, citation: "Montant" },
    }));

    const [lot] = rpcCall(fixture, "sync_tender_lot_analysis")
      ?.p_lots as Array<Record<string, unknown>>;
    expect(lot).toMatchObject({
      summary_description: "Travaux de gros œuvre",
      evidence: {
        business_fields: {
          description_prestations: {
            citation: "Le lot 1 comprend les travaux de gros œuvre",
          },
        },
      },
    });
    expect(lot).not.toHaveProperty("contract_duration");
    expect(lot).not.toHaveProperty("work_start_date");
    expect(lot).not.toHaveProperty("estimated_value");
    const evidence = (lot?.evidence as {
      business_fields: Record<string, unknown>;
    }).business_fields;
    expect(Object.keys(evidence)).toEqual(["description_prestations"]);
  });

  it("hashes the canonical payload deterministically across identical runs", async () => {
    const first = fixtureClient({ tender, company });
    const second = fixtureClient({ tender, company });
    await createSupabaseAnalyzeStore(first.client)
      .createResultSink(marketAssembly(true))
      .write(marketPayload(businessFields));
    await createSupabaseAnalyzeStore(second.client)
      .createResultSink(marketAssembly(true))
      .write(marketPayload(businessFields));

    expect(rpcCall(first, "materialize_tender_lots")?.p_input_hash)
      .toBe(rpcCall(second, "materialize_tender_lots")?.p_input_hash);
  });

  it("keeps the sync alone when the mother is not eligible", async () => {
    const fixture = fixtureClient({ tender, company });
    const store = createSupabaseAnalyzeStore(fixture.client);
    await store.createResultSink(marketAssembly(false))
      .write(marketPayload(businessFields));

    const names = fixture.rpc.mock.calls.map(([name]) => name);
    expect(names).not.toContain("materialize_tender_lots");
    expect(names).toContain("sync_tender_lot_analysis");
  });

  it("never materializes for a direct lot analysis", async () => {
    const fixture = fixtureClient({ tender: lotTender, company });
    const store = createSupabaseAnalyzeStore(fixture.client);
    await store.createResultSink({
      ...marketAssembly(true),
      queue: { queueId: "queue-1", tenderId: "lot-1", attempts: 1 },
      recordType: "lot",
      lot: {
        parentTenderId: "parent-1",
        number: "1",
        title: "Gros œuvre",
        sourceLotKey: "boamp:lot-1",
      },
    }).write({ ...marketPayload(businessFields), tenderId: "lot-1" });

    const names = fixture.rpc.mock.calls.map(([name]) => name);
    expect(names).not.toContain("materialize_tender_lots");
    expect(names).toContain("sync_tender_lot_analysis");
  });

  it("falls back to the sync alone on a structure-guard error", async () => {
    const fixture = fixtureClient({
      tender,
      company,
      rpcErrors: {
        materialize_tender_lots: {
          message: "lot_structure_owned_by_human",
          code: "P0001",
        },
      },
    });
    const logger = { info: vi.fn() };
    const store = createSupabaseAnalyzeStore(fixture.client, { logger });
    await store.createResultSink(marketAssembly(true))
      .write(marketPayload(businessFields));

    const names = fixture.rpc.mock.calls.map(([name]) => name);
    expect(names).toContain("materialize_tender_lots");
    expect(names).toContain("sync_tender_lot_analysis");
    expect(logger.info).toHaveBeenCalledWith(
      "analyze_lot_materialization_skipped",
      expect.objectContaining({
        tender_id: "tender-1",
        error: expect.stringContaining("lot_structure_owned_by_human"),
      }),
    );
  });

  it("fails closed on a non-guard materialization error", async () => {
    const fixture = fixtureClient({
      tender,
      company,
      rpcErrors: {
        materialize_tender_lots: {
          message: "connection reset",
          code: "08006",
        },
      },
    });
    const store = createSupabaseAnalyzeStore(fixture.client);

    await expect(
      store.createResultSink(marketAssembly(true))
        .write(marketPayload(businessFields)),
    ).rejects.toThrow("ANALYZE_LOT_MATERIALIZE_FAILED");
    expect(fixture.rpc.mock.calls.map(([name]) => name))
      .not.toContain("sync_tender_lot_analysis");
  });

  it("computes the eligibility flag from the tender row at assembly time", async () => {
    const eligibleFixture = fixtureClient({
      tender,
      company,
      documents: [document],
    });
    await expect(
      createSupabaseAnalyzeStore(eligibleFixture.client)
        .assembleCandidate(candidate),
    ).resolves.toMatchObject({
      status: "ready",
      assembly: { autoMaterializeLots: true },
    });

    const lockedFixture = fixtureClient({
      tender: { ...tender, lot_structure_locked_at: "2026-07-20T10:00:00Z" },
      company,
      documents: [document],
    });
    await expect(
      createSupabaseAnalyzeStore(lockedFixture.client)
        .assembleCandidate(candidate),
    ).resolves.toMatchObject({
      status: "ready",
      assembly: { autoMaterializeLots: false },
    });
  });
});
