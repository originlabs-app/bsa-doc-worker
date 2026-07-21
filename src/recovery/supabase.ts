import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import type {
  RecoveryAttemptStore,
  RecoveryStoredDocument,
  RecoveryTarget,
} from "./contracts.js";

interface SupabaseResult {
  data: unknown;
  error: unknown;
}

export interface RecoverySupabaseClient {
  rpc(name: string, args: Record<string, unknown>): Promise<SupabaseResult>;
}

const CandidateRow = z.object({
  tender_id: z.string().min(1),
  company_id: z.string().min(1),
  title: z.string().min(1),
  buyer_name: z.string().default(""),
  reference: z.string().default(""),
  buyer_profile_link: z.string().url(),
  lot_titles: z.array(z.string()).default([]),
});

const ReservationRow = z.object({
  attempt_id: z.string().min(1),
  attempt_number: z.coerce.number().int().positive(),
});

const PersistResult = z.object({
  inserted_documents: z.coerce.number().int().min(0),
  queue_status: z.string(),
});

function checked(result: SupabaseResult, code: string): unknown {
  if (result.error) throw new Error(code, { cause: result.error });
  return result.data;
}

export function createRecoverySupabaseClient(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
}): RecoverySupabaseClient {
  return createClient(input.supabaseUrl, input.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as RecoverySupabaseClient;
}

function toSqlDocuments(documents: readonly RecoveryStoredDocument[]) {
  return documents.map((document) => ({
    file_name: document.fileName,
    object_path: document.objectPath,
    source_url: document.sourceUrl,
    source_reference: document.sourceReference,
    bytes: document.bytes,
    sha256: document.sha256,
  }));
}

export function createSupabaseRecoveryStore(
  client: RecoverySupabaseClient,
): RecoveryAttemptStore {
  return {
    async listEligible(limit): Promise<RecoveryTarget[]> {
      const raw = checked(
        await client.rpc("list_tender_dce_recovery_candidates", {
          p_limit: limit,
        }),
        "RECOVERY_SELECTION_FAILED",
      );
      return z.array(CandidateRow).parse(raw).map((row) => ({
        tenderId: row.tender_id,
        companyId: row.company_id,
        title: row.title,
        buyerName: row.buyer_name,
        reference: row.reference,
        buyerProfileLink: row.buyer_profile_link,
        lotTitles: row.lot_titles,
      }));
    },

    async reserve(tenderId) {
      const raw = checked(
        await client.rpc("reserve_tender_dce_recovery_attempt", {
          p_tender_id: tenderId,
        }),
        "RECOVERY_RESERVATION_FAILED",
      );
      const rows = z.array(ReservationRow).parse(raw ?? []);
      const row = rows[0];
      return row
        ? { attemptId: row.attempt_id, attemptNumber: row.attempt_number }
        : null;
    },

    async finalize(input) {
      checked(
        await client.rpc("finalize_tender_dce_recovery_attempt", {
          p_attempt_id: input.attemptId,
          p_status: input.status,
          p_portal: input.portal,
          p_decision: input.decision,
          p_evidence: input.evidence,
        }),
        "RECOVERY_FINALIZE_FAILED",
      );
    },

    async persistFound(input) {
      const raw = checked(
        await client.rpc("persist_tender_dce_recovery_manifest", {
          p_attempt_id: input.attemptId,
          p_tender_id: input.tenderId,
          p_portal: input.portal,
          p_decision: input.decision,
          p_evidence: input.evidence,
          p_documents: toSqlDocuments(input.documents),
        }),
        "RECOVERY_PERSIST_FAILED",
      );
      const result = PersistResult.parse(raw);
      return {
        insertedDocuments: result.inserted_documents,
        queueStatus: result.queue_status,
      };
    },
  };
}
