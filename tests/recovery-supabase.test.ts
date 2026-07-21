import { describe, expect, it, vi } from "vitest";

import {
  createSupabaseRecoveryStore,
  type RecoverySupabaseClient,
} from "../src/recovery/supabase.js";

describe("createSupabaseRecoveryStore", () => {
  it("maps eligible SQL rows and delegates mutations to bounded RPCs", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "list_tender_dce_recovery_candidates") {
        return {
          data: [
            {
              tender_id: "tender-1",
              company_id: "company-1",
              title: "AO test",
              buyer_name: "Ville test",
              reference: "REF-1",
              buyer_profile_link: "https://example.test/profile",
              lot_titles: ["Lot isolation"],
            },
          ],
          error: null,
        };
      }
      if (name === "reserve_tender_dce_recovery_attempt") {
        return {
          data: [{ attempt_id: "attempt-1", attempt_number: 1 }],
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const client: RecoverySupabaseClient = { rpc };
    const store = createSupabaseRecoveryStore(client);

    await expect(store.listEligible(25)).resolves.toEqual([
      {
        tenderId: "tender-1",
        companyId: "company-1",
        title: "AO test",
        buyerName: "Ville test",
        reference: "REF-1",
        buyerProfileLink: "https://example.test/profile",
        lotTitles: ["Lot isolation"],
      },
    ]);
    await expect(store.reserve("tender-1")).resolves.toEqual({
      attemptId: "attempt-1",
      attemptNumber: 1,
    });
    await store.finalize({
      attemptId: "attempt-1",
      status: "ambiguous",
      portal: null,
      decision: "medium",
      evidence: {},
    });

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "list_tender_dce_recovery_candidates",
      "reserve_tender_dce_recovery_attempt",
      "finalize_tender_dce_recovery_attempt",
    ]);
  });
});
