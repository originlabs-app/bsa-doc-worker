import { describe, expect, it, vi } from "vitest";

import {
  classifyAnalysisRole,
  classifyAnalysisRoleFromText,
} from "../src/reader/classification.js";
import { createSupabaseReaderStore } from "../src/reader/supabase.js";

describe("reader document classification", () => {
  it.each([
    ["RC consultation.pdf", "rc"],
    ["Avis AAPC.pdf", "avis"],
    ["CCAP lot 1.pdf", "ccap"],
    ["Acte engagement.docx", "ae"],
    ["CCTP-ELEC.pdf", "cctp"],
    ["DPGF.xlsx", "dpgf"],
    ["BPU.xls", "bpu"],
    ["DQE.ods", "dqe"],
  ] as const)("classifies %s as %s", (fileName, role) => {
    expect(classifyAnalysisRole(fileName)).toBe(role);
  });

  it("uses content only when it identifies one unambiguous role", () => {
    expect(
      classifyAnalysisRoleFromText(
        "Cahier des clauses techniques particulières — prestations",
      ),
    ).toBe("cctp");
    expect(
      classifyAnalysisRoleFromText(
        "Règlement de la consultation et cahier des charges",
      ),
    ).toBeNull();
  });
});

describe("Supabase reader RPC contract", () => {
  it("maps owner-fenced queue calls and the spend ledger exactly", async () => {
    const rpc = vi.fn().mockImplementation((name: string) =>
      Promise.resolve({
        data:
          name === "upsert_dce_zip_child"
            ? {
                document_id: "child-1",
                tender_id: "tender-1",
                parent_document_id: "parent-1",
                file_name: "BPU.xlsx",
                url: "company/tender/BPU.xlsx",
              }
            : { ok: true },
        error: null,
      }),
    );
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = {
      rpc,
      storage: { from: vi.fn(() => ({ upload })) },
    };
    const store = createSupabaseReaderStore(client);

    await store.claimNext("reader:1");
    await store.assertClaim("queue-1", "reader:1");
    await store.heartbeat("queue-1", "reader:1");
    await store.upsertZipChild({
      queueId: "queue-1",
      workerId: "reader:1",
      entryPath: "pieces/BPU.xlsx",
      fileName: "BPU.xlsx",
      analysisRole: "bpu",
      analysisRoleSource: "filename",
      extractionStatus: "extracted",
    });
    await store.complete({
      queueId: "queue-1",
      workerId: "reader:1",
      extractionStatus: "extracted",
      textStoragePath: "company/tender/dce-text/doc.txt",
      model: "model",
      costUsd: 0.02,
      notes: [],
    });
    await store.fail("queue-1", "reader:1", "ZIP_CORRUPT", []);
    await store.defer("queue-1", "reader:1", "SOURCE_EXPIRED", [], 86_400);
    await store.release("queue-1", "reader:1", "DRY_RUN_RELEASE", []);
    await store.recordSpend({
      tenderId: "tender-1",
      model: "model",
      costUsd: 0.02,
      metadata: { queue_id: "queue-1", role: "bpu" },
    });

    expect(rpc.mock.calls).toEqual([
      ["claim_next_dce_document_extraction", { p_worker_id: "reader:1" }],
      ["assert_dce_document_extraction_claim", { p_queue_id: "queue-1", p_worker_id: "reader:1" }],
      ["heartbeat_dce_document_extraction", { p_queue_id: "queue-1", p_worker_id: "reader:1" }],
      ["upsert_dce_zip_child", {
        p_queue_id: "queue-1",
        p_worker_id: "reader:1",
        p_entry_path: "pieces/BPU.xlsx",
        p_file_name: "BPU.xlsx",
        p_analysis_role: "bpu",
        p_analysis_role_source: "filename",
        p_extraction_status: "extracted",
      }],
      ["complete_dce_document_extraction", {
        p_queue_id: "queue-1",
        p_worker_id: "reader:1",
        p_extraction_status: "extracted",
        p_text_storage_path: "company/tender/dce-text/doc.txt",
        p_model: "model",
        p_cost_usd: 0.02,
        p_notes: [],
      }],
      ["fail_dce_document_extraction", {
        p_queue_id: "queue-1",
        p_worker_id: "reader:1",
        p_error: "ZIP_CORRUPT",
        p_notes: [],
      }],
      ["defer_dce_document_extraction", {
        p_queue_id: "queue-1",
        p_worker_id: "reader:1",
        p_error: "SOURCE_EXPIRED",
        p_notes: [],
        p_retry_after_seconds: 86_400,
      }],
      ["release_dce_document_extraction", {
        p_queue_id: "queue-1",
        p_worker_id: "reader:1",
        p_error: "DRY_RUN_RELEASE",
        p_notes: [],
      }],
      ["record_ai_spend", {
        p_tender_id: "tender-1",
        p_step: "dce_extraction",
        p_model: "model",
        p_cost_usd: 0.02,
        p_metadata: { queue_id: "queue-1", role: "bpu" },
      }],
    ]);
  });
});
