import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { DOCUMENT_READER_ROLES } from "../llm/document-schemas.js";
import { buildDceTextPath } from "../reader/storage.js";
import type { AnalysisWritePayload } from "./service.js";
import type {
  AnalyzeApplyStore,
  AnalyzeAssemblyReport,
  AnalyzeDossierAssembly,
  AnalyzeQueueCandidate,
  AnalyzeReadStore,
} from "./wiring.js";

const STORAGE_BUCKET = "appel-offre-documents";
const MAX_DOCUMENTS = 100;
const MAX_TOTAL_CHARACTERS = 1_000_000;
const READABLE_EXTRACTION_STATUSES = new Set([
  "extracted",
  "word_extracted",
  "extracted_ocr",
]);
const TERMINAL_UNREAD_STATUSES = new Set([
  "empty_text",
  "failed",
  "unsupported_format",
  "source_expired",
  "too_large",
  "empty_file",
]);

interface SupabaseResult {
  data: unknown;
  error: unknown;
}

export interface AnalyzeSupabaseClient {
  from(table: string): unknown;
  rpc(name: string, args: Record<string, unknown>): Promise<SupabaseResult>;
  storage: {
    from(bucket: string): {
      download(path: string): Promise<{ data: Blob | null; error: unknown }>;
    };
  };
}

const QueueRowSchema = z.object({
  id: z.string().min(1),
  tender_id: z.string().min(1),
  attempts: z.coerce.number().int().min(0),
}).passthrough();

const TenderRowSchema = z.object({
  id: z.string().min(1),
  company_id: z.string().min(1),
  title: z.string().min(1),
  buyer_name: z.string().nullable(),
  summary_description: z.string().nullable(),
  contract_subject: z.string().nullable(),
  project_location: z.string().nullable(),
  city: z.string().nullable(),
  department_code: z.string().nullable(),
  estimated_value: z.union([z.string(), z.number()]).nullable(),
  procedure_type: z.string().nullable(),
  relevance_score: z.union([z.string(), z.number()]).nullable(),
  deleted_at: z.string().nullable(),
  status: z.string(),
  record_type: z.string().nullable(),
  parent_tender_id: z.string().nullable(),
}).passthrough();

const NullableStringArray = z.array(z.string()).nullable();
const CompanyRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable(),
  core_business: z.string().nullable(),
  desired_contracts: z.string().nullable(),
  code_naf: z.string().nullable(),
  search_keywords: NullableStringArray,
  exclusion_keywords: NullableStringArray,
  search_departments: NullableStringArray,
  search_city: z.string().nullable(),
  search_radius_km: z.number().nullable(),
  search_market_types: NullableStringArray,
  certifications_held: NullableStringArray,
  certifications_excluded: NullableStringArray,
  accepts_social_insertion: z.boolean().nullable(),
}).passthrough();

const QualificationRowSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  derogeable: z.boolean(),
  aliases: NullableStringArray,
}).passthrough();

const DocumentRowSchema = z.object({
  id: z.string().min(1),
  tender_id: z.string().min(1),
  file_name: z.string().min(1),
  url: z.string().min(1),
  parent_document_id: z.string().nullable(),
  analysis_role: z.string().nullable(),
  extraction_status: z.string().nullable(),
  analysis_lot_number: z.string().nullable(),
}).passthrough();

function throwSupabaseError(error: unknown, fallback: string): never {
  throw new Error(fallback, { cause: error });
}

function checked(result: SupabaseResult, fallback: string): unknown {
  if (result.error) throwSupabaseError(result.error, fallback);
  return result.data;
}

function finiteNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonBlank(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function locationOf(input: {
  project_location: string | null;
  city: string | null;
  department_code: string | null;
}): string | null {
  const explicit = nonBlank(input.project_location);
  if (explicit) return explicit;
  return nonBlank([input.city, input.department_code]
    .map((value) => nonBlank(value))
    .filter((value): value is string => value !== null)
    .join(" "));
}

function isArchive(fileName: string): boolean {
  return /\.(zip|7z|rar|tar|gz)$/i.test(fileName.trim());
}

function roleOf(value: string | null) {
  return value && DOCUMENT_READER_ROLES.some((role) => role === value)
    ? value as (typeof DOCUMENT_READER_ROLES)[number]
    : "inconnu";
}

async function singleRow(
  client: AnalyzeSupabaseClient,
  table: string,
  columns: string,
  id: string,
): Promise<unknown> {
  const result = await (client.from(table) as {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<SupabaseResult>;
      };
    };
  }).select(columns).eq("id", id).maybeSingle();
  return checked(result, `ANALYZE_${table.toUpperCase()}_READ_FAILED`);
}

async function listQualifications(
  client: AnalyzeSupabaseClient,
): Promise<unknown[]> {
  const result = await (client.from("mandatory_qualification") as {
    select(columns: string): {
      order(column: string, options: { ascending: boolean }): Promise<SupabaseResult>;
    };
  }).select("code,label,derogeable,aliases")
    .order("code", { ascending: true });
  const data = checked(result, "ANALYZE_QUALIFICATIONS_READ_FAILED");
  return Array.isArray(data) ? data : [];
}

async function listDocuments(
  client: AnalyzeSupabaseClient,
  tenderId: string,
): Promise<unknown[]> {
  const result = await client.rpc("list_tender_analysis_documents", {
    _tender_id: tenderId,
  });
  const data = checked(result, "ANALYZE_DOCUMENTS_READ_FAILED");
  return Array.isArray(data) ? data : [];
}

async function assembleCandidate(
  client: AnalyzeSupabaseClient,
  candidate: AnalyzeQueueCandidate,
): Promise<AnalyzeAssemblyReport> {
  const rawTender = await singleRow(
    client,
    "tender",
    "id,company_id,title,buyer_name,summary_description,contract_subject,project_location,city,department_code,estimated_value,procedure_type,relevance_score,deleted_at,status,record_type,parent_tender_id",
    candidate.tenderId,
  );
  if (!rawTender) return { status: "skipped", reason: "tender_missing" };
  const tender = TenderRowSchema.parse(rawTender);
  if (tender.deleted_at !== null) {
    return { status: "skipped", reason: "tender_deleted" };
  }
  if (tender.status === "rejected" || tender.status === "no_go") {
    return { status: "skipped", reason: `tender_status_${tender.status}` };
  }

  const [rawCompany, rawQualifications, rawDocuments] = await Promise.all([
    singleRow(
      client,
      "company",
      "id,name,core_business,desired_contracts,code_naf,search_keywords,exclusion_keywords,search_departments,search_city,search_radius_km,search_market_types,certifications_held,certifications_excluded,accepts_social_insertion",
      tender.company_id,
    ),
    listQualifications(client),
    listDocuments(client, candidate.tenderId),
  ]);
  if (!rawCompany) throw new Error("ANALYZE_COMPANY_MISSING");
  const company = CompanyRowSchema.parse(rawCompany);
  const qualifications = z.array(QualificationRowSchema).parse(rawQualifications);
  const documents = z.array(DocumentRowSchema).parse(rawDocuments);
  if (documents.length > MAX_DOCUMENTS) {
    throw new Error("ANALYZE_DOCUMENT_LIMIT_EXCEEDED");
  }

  const relevantDocuments = documents.filter((document) =>
    !isArchive(document.file_name)
  );
  const hasNotReadyDocument = relevantDocuments.some((document) => {
    const status = document.extraction_status;
    return !status || (
      !READABLE_EXTRACTION_STATUSES.has(status) &&
      !TERMINAL_UNREAD_STATUSES.has(status)
    );
  });
  if (hasNotReadyDocument) {
    return { status: "not_ready", reason: "ANALYZE_DOCUMENTS_NOT_READY" };
  }

  const readableDocuments = relevantDocuments.filter((document) =>
    document.extraction_status !== null &&
    READABLE_EXTRACTION_STATUSES.has(document.extraction_status)
  );
  const omittedDocuments = relevantDocuments.length - readableDocuments.length;
  const assembledDocuments = [];
  let totalCharacters = 0;
  for (const document of readableDocuments) {
    const path = buildDceTextPath({
      url: document.url,
      tenderId: document.tender_id,
      documentId: document.id,
    });
    const { data, error } = await client.storage.from(STORAGE_BUCKET).download(path);
    if (error) throwSupabaseError(error, "ANALYZE_DOCUMENT_TEXT_READ_FAILED");
    if (!data) throw new Error("ANALYZE_DOCUMENT_TEXT_MISSING");
    const text = (await data.text()).trim();
    if (!text) throw new Error("ANALYZE_DOCUMENT_TEXT_EMPTY");
    totalCharacters += text.length;
    if (totalCharacters > MAX_TOTAL_CHARACTERS) {
      throw new Error("ANALYZE_CHARACTER_LIMIT_EXCEEDED");
    }
    assembledDocuments.push({
      id: document.id,
      fileName: document.file_name,
      role: roleOf(document.analysis_role),
      lotNumber: nonBlank(document.analysis_lot_number),
      text,
    });
  }
  if (assembledDocuments.length === 0) {
    throw new Error("ANALYZE_NO_READABLE_DOCUMENTS");
  }

  return {
    status: "ready",
    assembly: {
      queue: candidate,
      companyId: tender.company_id,
      recordType: tender.record_type,
      existingScore: finiteNumber(tender.relevance_score),
      coverage: {
        complete: omittedDocuments === 0,
        documentsCount: assembledDocuments.length,
        omittedDocuments,
        totalCharacters,
      },
      dossier: {
        tender: {
          id: tender.id,
          title: tender.title,
          buyerName: nonBlank(tender.buyer_name),
          description: nonBlank(tender.summary_description) ??
            nonBlank(tender.contract_subject),
          location: locationOf(tender),
          estimatedAmount: finiteNumber(tender.estimated_value),
          procedureType: nonBlank(tender.procedure_type),
        },
        company: {
          name: company.name,
          core_business: company.core_business,
          desired_contracts: company.desired_contracts,
          code_naf: company.code_naf,
          search_keywords: company.search_keywords,
          exclusion_keywords: company.exclusion_keywords,
          search_departments: company.search_departments,
          search_city: company.search_city,
          search_radius_km: company.search_radius_km,
          search_market_types: company.search_market_types,
          certifications_held: company.certifications_held,
          certifications_excluded: company.certifications_excluded,
          accepts_social_insertion: company.accepts_social_insertion,
        },
        mandatoryQualifications: qualifications.map((qualification) => ({
          code: qualification.code,
          label: qualification.label,
          derogeable: qualification.derogeable,
          aliases: qualification.aliases,
        })),
        documents: assembledDocuments,
      },
    },
  };
}

async function updateQueue(
  client: AnalyzeSupabaseClient,
  queueId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const result = await (client.from("dce_analysis_queue") as {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): Promise<SupabaseResult>;
    };
  }).update(values).eq("id", queueId);
  checked(result, "ANALYZE_QUEUE_WRITE_FAILED");
}

function normalizedLotKey(value: string): string {
  return value.trim().toLocaleLowerCase("fr").replace(/\s+/g, "-");
}

async function writeAnalysis(
  client: AnalyzeSupabaseClient,
  assembly: AnalyzeDossierAssembly,
  payload: AnalysisWritePayload,
): Promise<void> {
  const guardedUpdate = await (client.from("tender") as {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): {
        is(column: string, value: null): {
          not(column: string, operator: string, value: string): {
            filter(column: string, operator: string, value: string): {
              select(columns: string): {
                maybeSingle(): Promise<SupabaseResult>;
              };
            };
          };
        };
      };
    };
  }).update({
    ...payload.tenderValues,
    analysis_state: assembly.coverage.complete ? "completed" : "partial",
  })
    .eq("id", payload.tenderId)
    .is("deleted_at", null)
    .not("status", "in", "(rejected,no_go)")
    // isdistinct is NULL-safe: standalone tenders (NULL lot state) stay
    // writable while human-validated lots remain untouchable. or= is not
    // an option: PostgREST rejects it on UPDATE (42703).
    .filter("lot_analysis_state", "isdistinct", "human_validated")
    .select("id")
    .maybeSingle();
  const updated = checked(guardedUpdate, "ANALYZE_TENDER_WRITE_FAILED");
  if (!updated) throw new Error("ANALYZE_TENDER_WRITE_GUARD");

  const analysisState = assembly.coverage.complete
    ? "documentary_complete"
    : "documentary_partial";
  if (assembly.recordType === "market" && payload.lots.length > 0) {
    const result = await client.rpc("sync_tender_lot_analysis", {
      p_parent_tender_id: payload.tenderId,
      p_analysis_state: analysisState,
      p_lots: payload.lots.map((lot) => ({
        source_lot_key: `number:${normalizedLotKey(lot.number)}`,
        lot_number: lot.number,
        lot_title: lot.title,
        relevance_score: lot.relevanceScore,
        relevance_reason: lot.relevanceReason,
        lot_fit_status: lot.verdict,
      })),
      p_run_evidence: {
        queue_id: assembly.queue.queueId,
        coverage_complete: assembly.coverage.complete,
        documents_count: assembly.coverage.documentsCount,
        omitted_documents: assembly.coverage.omittedDocuments,
      },
    });
    checked(result, "ANALYZE_LOT_SYNC_FAILED");
  }

  const ledgerResult = await client.rpc("record_ai_spend", {
    p_tender_id: payload.ledger.tenderId,
    p_step: payload.ledger.step,
    p_model: payload.ledger.model,
    p_cost_usd: payload.ledger.costUsd,
    p_metadata: payload.ledger.metadata,
  });
  checked(ledgerResult, "ANALYZE_LEDGER_WRITE_FAILED");
}

export type SupabaseAnalyzeStore = AnalyzeReadStore & AnalyzeApplyStore;

export function createSupabaseAnalyzeStore(
  client: AnalyzeSupabaseClient,
): SupabaseAnalyzeStore {
  return {
    async peekCandidates(limit, observedAt) {
      const result = await (client.from("dce_analysis_queue") as {
        select(columns: string): {
          or(filter: string): {
            lte(column: string, value: string): {
              order(column: string, options: { ascending: boolean }): {
                order(column: string, options: { ascending: boolean }): {
                  order(column: string, options: { ascending: boolean }): {
                    limit(value: number): Promise<SupabaseResult>;
                  };
                };
              };
            };
          };
        };
      }).select("id,tender_id,attempts")
        .or("status.eq.pending,and(status.eq.failed,attempts.lt.3)")
        .lte("created_at", observedAt)
        .order("queue_order_at", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      const data = checked(result, "ANALYZE_QUEUE_READ_FAILED");
      const rows = z.array(QueueRowSchema).parse(Array.isArray(data) ? data : []);
      return rows.map((row) => ({
        queueId: row.id,
        tenderId: row.tender_id,
        attempts: row.attempts,
      }));
    },
    assembleCandidate: (candidate) => assembleCandidate(client, candidate),
    async readCurrentScore(tenderId) {
      const raw = await singleRow(client, "tender", "id,relevance_score", tenderId);
      if (!raw || typeof raw !== "object") return null;
      const value = (raw as Record<string, unknown>).relevance_score;
      return finiteNumber(
        typeof value === "string" || typeof value === "number" ? value : null,
      );
    },
    async claim(queueId) {
      const result = await client.rpc("claim_dce_analysis_queue_row", {
        p_queue_id: queueId,
      });
      const data = checked(result, "ANALYZE_QUEUE_CLAIM_FAILED");
      if (data !== "claimed" && data !== "skipped" && data !== "unavailable") {
        throw new Error("ANALYZE_QUEUE_CLAIM_INVALID_RESPONSE");
      }
      return data;
    },
    createResultSink(assembly) {
      return { write: (payload) => writeAnalysis(client, assembly, payload) };
    },
    markDone(queueId, processedAt) {
      return updateQueue(client, queueId, {
        status: "done",
        processed_at: processedAt,
        last_error: null,
      });
    },
    markPending(queueId, issue) {
      return updateQueue(client, queueId, {
        status: "pending",
        last_error: issue,
      });
    },
    markFailed(queueId, attempts, issue) {
      return updateQueue(client, queueId, {
        status: "failed",
        attempts,
        last_error: issue,
      });
    },
  };
}

export function createAnalyzeSupabaseClient(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
}): AnalyzeSupabaseClient {
  return createClient(input.supabaseUrl, input.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as AnalyzeSupabaseClient;
}
