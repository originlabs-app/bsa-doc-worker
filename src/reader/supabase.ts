import { createClient } from "@supabase/supabase-js";

import type {
  AiSpendDraft,
  ClaimedDocument,
  CompleteExtractionInput,
  ExtractionNote,
  MaterializedZipChild,
  ZipChildUpsertInput,
} from "./types.js";

const STORAGE_BUCKET = "appel-offre-documents";

interface RpcResult {
  data: unknown;
  error: unknown;
}

export interface SupabaseReaderClient {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Uint8Array,
        options: { contentType: string; upsert: boolean },
      ): Promise<{ error: unknown }>;
    };
  };
}

export class ReaderClaimLostError extends Error {
  readonly code = "READER_CLAIM_LOST";

  constructor(
    public readonly queueId: string,
    public readonly workerId: string,
  ) {
    super("READER_CLAIM_LOST");
    this.name = "ReaderClaimLostError";
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error);
  return ["message", "details", "hint", "code"]
    .map((key) => (error as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === "string")
    .join(":");
}

function throwRpcError(error: unknown, queueId?: string, workerId?: string): never {
  if (
    queueId &&
    workerId &&
    errorText(error).includes("stale_document_extraction_claim")
  ) {
    throw new ReaderClaimLostError(queueId, workerId);
  }
  throw error instanceof Error ? error : new Error("READER_RPC_FAILED");
}

export interface ReaderStore {
  claimNext(workerId: string): Promise<ClaimedDocument | null>;
  assertClaim(queueId: string, workerId: string): Promise<void>;
  heartbeat(queueId: string, workerId: string): Promise<void>;
  uploadText(path: string, text: string): Promise<void>;
  uploadObject(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  upsertZipChild(input: ZipChildUpsertInput): Promise<MaterializedZipChild>;
  complete(input: CompleteExtractionInput): Promise<unknown>;
  fail(
    queueId: string,
    workerId: string,
    error: string,
    notes: ExtractionNote[],
  ): Promise<unknown>;
  defer(
    queueId: string,
    workerId: string,
    error: string,
    notes: ExtractionNote[],
    retryAfterSeconds: number,
  ): Promise<unknown>;
  release(
    queueId: string,
    workerId: string,
    error: string,
    notes: ExtractionNote[],
  ): Promise<unknown>;
  recordSpend(entry: AiSpendDraft): Promise<unknown>;
}

async function checkedRpc(
  client: SupabaseReaderClient,
  name: string,
  args: Record<string, unknown>,
  owner?: { queueId: string; workerId: string },
): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) throwRpcError(error, owner?.queueId, owner?.workerId);
  return data;
}

export function createSupabaseReaderStore(
  client: SupabaseReaderClient,
): ReaderStore {
  return {
    async claimNext(workerId) {
      return (await checkedRpc(client, "claim_next_dce_document_extraction", {
        p_worker_id: workerId,
      })) as ClaimedDocument | null;
    },
    async assertClaim(queueId, workerId) {
      await checkedRpc(
        client,
        "assert_dce_document_extraction_claim",
        { p_queue_id: queueId, p_worker_id: workerId },
        { queueId, workerId },
      );
    },
    async heartbeat(queueId, workerId) {
      await checkedRpc(
        client,
        "heartbeat_dce_document_extraction",
        { p_queue_id: queueId, p_worker_id: workerId },
        { queueId, workerId },
      );
    },
    async uploadText(path, text) {
      const { error } = await client.storage.from(STORAGE_BUCKET).upload(
        path,
        new TextEncoder().encode(text),
        { contentType: "text/plain", upsert: true },
      );
      if (error) throwRpcError(error);
    },
    async uploadObject(path, bytes, contentType) {
      const { error } = await client.storage
        .from(STORAGE_BUCKET)
        .upload(path, bytes, { contentType, upsert: true });
      if (error) throwRpcError(error);
    },
    async upsertZipChild(input) {
      const data = await checkedRpc(
        client,
        "upsert_dce_zip_child",
        {
          p_queue_id: input.queueId,
          p_worker_id: input.workerId,
          p_entry_path: input.entryPath,
          p_file_name: input.fileName,
          p_analysis_role: input.analysisRole,
          p_analysis_role_source: input.analysisRoleSource,
          p_extraction_status: input.extractionStatus,
        },
        { queueId: input.queueId, workerId: input.workerId },
      );
      if (!data || typeof data !== "object" || !("document_id" in data)) {
        throw new Error("ZIP_CHILD_RPC_INVALID_RESPONSE");
      }
      return data as unknown as MaterializedZipChild;
    },
    async complete(input) {
      return checkedRpc(
        client,
        "complete_dce_document_extraction",
        {
          p_queue_id: input.queueId,
          p_worker_id: input.workerId,
          p_extraction_status: input.extractionStatus,
          p_text_storage_path: input.textStoragePath,
          p_model: input.model,
          p_cost_usd: input.costUsd,
          p_notes: input.notes,
        },
        { queueId: input.queueId, workerId: input.workerId },
      );
    },
    async fail(queueId, workerId, error, notes) {
      return checkedRpc(
        client,
        "fail_dce_document_extraction",
        {
          p_queue_id: queueId,
          p_worker_id: workerId,
          p_error: error,
          p_notes: notes,
        },
        { queueId, workerId },
      );
    },
    async defer(queueId, workerId, error, notes, retryAfterSeconds) {
      return checkedRpc(
        client,
        "defer_dce_document_extraction",
        {
          p_queue_id: queueId,
          p_worker_id: workerId,
          p_error: error,
          p_notes: notes,
          p_retry_after_seconds: retryAfterSeconds,
        },
        { queueId, workerId },
      );
    },
    async release(queueId, workerId, error, notes) {
      return checkedRpc(
        client,
        "release_dce_document_extraction",
        {
          p_queue_id: queueId,
          p_worker_id: workerId,
          p_error: error,
          p_notes: notes,
        },
        { queueId, workerId },
      );
    },
    async recordSpend(entry) {
      return checkedRpc(client, "record_ai_spend", {
        p_tender_id: entry.tenderId,
        p_step: "dce_extraction",
        p_model: entry.model,
        p_cost_usd: entry.costUsd,
        p_metadata: entry.metadata,
      });
    },
  };
}

export function createReaderSupabaseClient(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
}): SupabaseReaderClient {
  return createClient(input.supabaseUrl, input.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SupabaseReaderClient;
}
