import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { DOCUMENT_READER_ROLES } from "../llm/document-schemas.js";
import type { WorkerLogger } from "../logger.js";
import { buildDceTextPath } from "../reader/storage.js";
import { shouldAutoMaterializeTenderLots } from "./domain.js";
import {
  DEFAULT_ANALYZE_RECORD_TYPES,
  type AnalyzeRecordType,
} from "./config.js";
import type { AnalyzeDocumentInput } from "./agent-types.js";
import { groundBusinessField } from "./grounding.js";
import {
  normalizeLotNumberValue,
  type AnalysisWritePayload,
} from "./service.js";
import type { LotBusinessFields } from "./types.js";
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
  deadline_date: z.string().nullable(),
  submission_date: z.string().nullable(),
  relevance_score: z.union([z.string(), z.number()]).nullable(),
  deleted_at: z.string().nullable(),
  status: z.string(),
  record_type: z.string().nullable(),
  parent_tender_id: z.string().nullable(),
  lot_number: z.string().nullable(),
  lot_title: z.string().nullable(),
  source_lot_key: z.string().nullable(),
  lot_analysis_state: z.string().nullable(),
  source: z.string().nullable(),
  lot_structure_mode: z.string().nullable(),
  lot_structure_origin: z.string().nullable(),
  lot_structure_locked_at: z.string().nullable(),
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

// LOT D roster source: live lot children already materialized in the DB.
async function countExistingLots(
  client: AnalyzeSupabaseClient,
  parentTenderId: string,
): Promise<number> {
  const result = await (client.from("tender") as {
    select(columns: string): {
      eq(column: string, value: string): {
        eq(column: string, value: string): {
          is(column: string, value: null): Promise<SupabaseResult>;
        };
      };
    };
  }).select("id")
    .eq("parent_tender_id", parentTenderId)
    .eq("record_type", "lot")
    .is("deleted_at", null);
  const data = checked(result, "ANALYZE_EXISTING_LOTS_READ_FAILED");
  return Array.isArray(data) ? data.length : 0;
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
    "id,company_id,title,buyer_name,summary_description,contract_subject,project_location,city,department_code,estimated_value,procedure_type,deadline_date,submission_date,relevance_score,deleted_at,status,record_type,parent_tender_id,lot_number,lot_title,source_lot_key,lot_analysis_state,source,lot_structure_mode,lot_structure_origin,lot_structure_locked_at",
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
  const isDirectLot = tender.record_type === "lot";
  if (isDirectLot && tender.lot_analysis_state === "human_validated") {
    // Edge parity (handler.ts): a human-validated lot is never re-analyzed.
    return { status: "skipped", reason: "lot_human_validated" };
  }
  if (isDirectLot && tender.parent_tender_id === null) {
    return { status: "skipped", reason: "lot_orphan" };
  }
  const lotContext = isDirectLot && tender.parent_tender_id !== null
    ? {
      parentTenderId: tender.parent_tender_id,
      number: nonBlank(tender.lot_number),
      title: nonBlank(tender.lot_title),
      sourceLotKey: nonBlank(tender.source_lot_key),
    }
    : null;

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

  const autoMaterializeLots = shouldAutoMaterializeTenderLots({
    source: tender.source,
    status: tender.status,
    record_type: tender.record_type,
    lot_structure_mode: tender.lot_structure_mode,
    lot_structure_origin: tender.lot_structure_origin,
    lot_structure_locked_at: tender.lot_structure_locked_at,
  });
  // The roster gate only matters when a materialization can happen: the
  // children count is read exactly then, at assembly time (the RPC re-checks
  // its own guards server-side anyway).
  const existingLotCount = autoMaterializeLots
    ? await countExistingLots(client, candidate.tenderId)
    : 0;

  return {
    status: "ready",
    assembly: {
      queue: candidate,
      companyId: tender.company_id,
      recordType: tender.record_type,
      lot: lotContext,
      autoMaterializeLots,
      existingLotCount,
      existingScore: finiteNumber(tender.relevance_score),
      // Same coalesce order as the edge toScoringTender (scorer.ts:166-168).
      deadlineDate: nonBlank(tender.deadline_date) ??
        nonBlank(tender.submission_date),
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
        ...(lotContext
          ? { targetLot: { number: lotContext.number, title: lotContext.title } }
          : {}),
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

// The DB source_lot_key is authoritative when present (never rebuilt);
// otherwise fall back to the same number-based key the market path builds.
function sourceLotKeyOf(lot: AnalysisWritePayload["lots"][number]): string {
  if (lot.sourceLotKey !== null) return lot.sourceLotKey;
  if (lot.number !== null) return `number:${normalizedLotKey(lot.number)}`;
  throw new Error("ANALYZE_LOT_KEY_MISSING");
}

// worker businessFields key → RPC column key → RPC evidence key (French).
const BUSINESS_FIELD_MAPPING = [
  ["summaryDescription", "summary_description", "description_prestations"],
  ["contractDuration", "contract_duration", "duree_marche"],
  ["workStartDate", "work_start_date", "date_execution"],
  ["estimatedValue", "estimated_value", "montant"],
] as const;

interface BusinessFieldContext {
  documents: readonly AnalyzeDocumentInput[];
  log?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Presence-based projection of the documentary business fields: a key is sent
 * to the RPCs only when the field is present AND re-grounded against the
 * assembled dossier (LOT D, defensive re-validation on top of the service
 * pass): strict schema, known documentId, citation found in THAT document,
 * amount readable in the citation. Anything unproven degrades to an ABSENT
 * key (dedicated log, never an exception): the RPC would reject the whole
 * sync with 23514 otherwise, and an absent key leaves the column untouched.
 * Edge parity (LotBusinessFieldEvidence): each evidence entry carries the
 * role/fileName of the source document next to the citation. The edge role
 * priority (DPGF/AE/CCAP per field) does not transpose here: the worker LLM
 * designates ONE source document per field, so there is no multi-extraction
 * choice to arbitrate.
 */
function businessFieldProjection(
  fields: LotBusinessFields | null | undefined,
  context: BusinessFieldContext,
): {
  columns: Record<string, string | number>;
  evidence: Record<
    string,
    { citation: string; role: string; fileName: string }
  >;
} {
  const columns: Record<string, string | number> = {};
  const evidence: Record<
    string,
    { citation: string; role: string; fileName: string }
  > = {};
  if (!fields) return { columns, evidence };
  for (const [field, column, evidenceKey] of BUSINESS_FIELD_MAPPING) {
    const grounding = groundBusinessField(field, fields[field], context.documents);
    if (grounding === null) continue;
    if (!grounding.ok) {
      const entry = fields[field];
      context.log?.("analyze_business_field_degraded", {
        field,
        reason: grounding.reason,
        document_id: entry && typeof entry === "object" &&
            typeof (entry as { documentId?: unknown }).documentId === "string"
          ? (entry as { documentId: string }).documentId
          : null,
      });
      continue;
    }
    columns[column] = grounding.value;
    evidence[evidenceKey] = {
      citation: grounding.citation,
      role: grounding.document.role,
      fileName: grounding.document.fileName,
    };
  }
  return { columns, evidence };
}

// One canonical candidate shared by materialize_tender_lots, the input hash
// and sync_tender_lot_analysis (which ignores the keys it does not read).
function lotRpcCandidate(
  lot: AnalysisWritePayload["lots"][number],
  order: number,
  context: BusinessFieldContext,
): Record<string, unknown> {
  const business = businessFieldProjection(lot.businessFields, context);
  return {
    source_lot_key: sourceLotKeyOf(lot),
    lot_number: lot.number,
    lot_title: lot.title,
    lot_order: order,
    relevance_score: lot.relevanceScore,
    relevance_reason: lot.relevanceReason,
    lot_fit_status: lot.verdict,
    ...business.columns,
    ...(Object.keys(business.evidence).length > 0
      ? { evidence: { business_fields: business.evidence } }
      : {}),
  };
}

/**
 * Idempotence key of THIS worker run: same canonical lot payload → same hash,
 * so the extraction-run upsert (parent, stage, hash, extractor_version) does
 * not pile up duplicate rows on retries. It is deliberately NOT a contract
 * with the edge hash, whose canonical candidate shape differs.
 */
function hashLotRpcPayload(lots: Array<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(lots)).digest("hex");
}

// Edge parity (analyze-dce/handler.ts isLotMaterializationGuardError): these
// server-side codes mean "a human owns the structure now"; the analysis is
// still valid, only the materialization must yield.
const LOT_MATERIALIZATION_GUARD_CODES = [
  "automatic_lot_materialization_requires_nukema",
  "lot_structure_locked_after_qualification",
  "lot_structure_owned_by_human",
  "manual_or_confirmed_single_tender_cannot_be_auto_structured",
  "existing_market_structure_is_not_bot_owned",
  "lot_structure_contains_human_decisions",
];

// LOT D — controlled RPC returns. The RPCs report what they actually did
// (migrations 20260714100000 and 20260721160000): an unmatched candidate or a
// sync that touched nothing means the analysis landed nowhere. The write then
// fails BEFORE the ledger, so the queue row goes failed instead of done and
// no spend is recorded for a lost analysis.
const MaterializeLotsResultSchema = z.object({
  run_id: z.string().min(1),
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  preserved: z.number().int().min(0),
  review_required: z.number().int().min(0),
}).passthrough();

const SyncLotAnalysisResultSchema = z.object({
  matched: z.number().int().min(0),
  unmatched: z.number().int().min(0),
  locked: z.number().int().min(0),
}).passthrough();

export class AnalyzeLotSyncUnmatchedError extends Error {
  readonly code = "ANALYZE_LOT_SYNC_UNMATCHED";

  constructor(
    public readonly matched: number,
    public readonly unmatched: number,
    public readonly locked: number,
  ) {
    super("ANALYZE_LOT_SYNC_UNMATCHED");
    this.name = "AnalyzeLotSyncUnmatchedError";
  }
}

/**
 * LOT D — roster proof before materialization. Reliable roster sources, in
 * the spirit of the edge (existing DB children merged into the candidates,
 * filename/DB lot numbers): the lot children already in base and the
 * analysis_lot_number carried by the assembled documents. When either exists,
 * an analysis producing fewer lots must not materialize (the RPC would flip
 * the missing lots to review_required). Without any reliable source, the
 * materialization requires the LLM's explicit rosterComplete declaration.
 * A refused roster falls back to the sync alone, like a guard error.
 */
function lotRosterVerdict(
  assembly: AnalyzeDossierAssembly,
  payload: AnalysisWritePayload,
):
  | { materialize: true }
  | { materialize: false; event: string; data: Record<string, unknown> } {
  const produced = payload.lots.length;
  const documentLotNumbers = new Set(
    assembly.dossier.documents.flatMap((document) => {
      if (!document.lotNumber) return [];
      return [
        normalizeLotNumberValue(document.lotNumber) ??
          document.lotNumber.trim().toLocaleLowerCase("fr"),
      ];
    }),
  );
  const expected = Math.max(assembly.existingLotCount, documentLotNumbers.size);
  if (expected > 0) {
    if (produced >= expected) return { materialize: true };
    return {
      materialize: false,
      event: "analyze_lot_roster_incomplete",
      data: {
        expected,
        produced,
        existing_lots: assembly.existingLotCount,
        document_lots: documentLotNumbers.size,
      },
    };
  }
  if (payload.rosterComplete) return { materialize: true };
  return {
    materialize: false,
    event: "analyze_lot_roster_unproven",
    data: { produced },
  };
}

function errorMessageOf(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);
}

function isLotMaterializationGuardError(error: unknown): boolean {
  const message = errorMessageOf(error);
  return LOT_MATERIALIZATION_GUARD_CODES.some((code) => message.includes(code));
}

async function writeAnalysis(
  client: AnalyzeSupabaseClient,
  assembly: AnalyzeDossierAssembly,
  payload: AnalysisWritePayload,
  logger?: WorkerLogger,
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
    // Direct lot: analysis_state (and every score/state field) is owned by the
    // sync RPC, which also honours fit_locked_by. The direct UPDATE only
    // carries the neutral fields prepared by buildAnalysisWritePayload.
    ...(assembly.lot
      ? {}
      : { analysis_state: assembly.coverage.complete ? "completed" : "partial" }),
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
  if (
    (assembly.recordType === "market" || assembly.lot !== null) &&
    payload.lots.length > 0
  ) {
    const businessContext: BusinessFieldContext = {
      documents: assembly.dossier.documents,
      ...(logger
        ? {
          log: (event: string, data: Record<string, unknown>) =>
            logger.info(event, { tender_id: payload.tenderId, ...data }),
        }
        : {}),
    };
    const lotsRpcPayload = payload.lots.map((lot, order) =>
      lotRpcCandidate(lot, order, businessContext)
    );
    const runEvidence = {
      queue_id: assembly.queue.queueId,
      coverage_complete: assembly.coverage.complete,
      documents_count: assembly.coverage.documentsCount,
      omitted_documents: assembly.coverage.omittedDocuments,
    };
    // Materialize the missing lot rows only for an eligible market mother —
    // never for a direct lot (its rows already exist under the parent) — and
    // only when the produced roster is proven exhaustive (LOT D).
    if (assembly.lot === null && assembly.autoMaterializeLots) {
      const roster = lotRosterVerdict(assembly, payload);
      if (!roster.materialize) {
        // Unproven roster: never rewrite the lot structure, sync alone.
        logger?.info(roster.event, {
          tender_id: payload.tenderId,
          ...roster.data,
        });
      } else {
        const materialized = await client.rpc("materialize_tender_lots", {
          p_parent_tender_id: payload.tenderId,
          p_analysis_state: analysisState,
          p_extraction_source: "dce",
          p_extractor_version: "analyze-dce-lots-v1",
          p_input_hash: hashLotRpcPayload(lotsRpcPayload),
          p_lots: lotsRpcPayload,
          p_run_evidence: runEvidence,
        });
        if (materialized.error) {
          if (!isLotMaterializationGuardError(materialized.error)) {
            throwSupabaseError(
              materialized.error,
              "ANALYZE_LOT_MATERIALIZE_FAILED",
            );
          }
          // Edge parity: the human structure now wins; keep the sync alone.
          logger?.info("analyze_lot_materialization_skipped", {
            tender_id: payload.tenderId,
            error: errorMessageOf(materialized.error),
          });
        } else {
          const materializedReport = MaterializeLotsResultSchema.safeParse(
            materialized.data,
          );
          if (!materializedReport.success) {
            throw new Error("ANALYZE_LOT_MATERIALIZE_INVALID_RESPONSE");
          }
          logger?.info("analyze_lot_materialized", {
            tender_id: payload.tenderId,
            run_id: materializedReport.data.run_id,
            created: materializedReport.data.created,
            updated: materializedReport.data.updated,
            preserved: materializedReport.data.preserved,
            review_required: materializedReport.data.review_required,
          });
        }
      }
    }
    const result = await client.rpc("sync_tender_lot_analysis", {
      // Direct lot: the RPC is addressed to the MARKET PARENT, which locks the
      // parent row and matches this single lot by source_lot_key/number. One
      // payload entry = one lot touched; the sibling lots stay untouched.
      p_parent_tender_id: assembly.lot
        ? assembly.lot.parentTenderId
        : payload.tenderId,
      p_analysis_state: analysisState,
      p_lots: lotsRpcPayload,
      p_run_evidence: runEvidence,
    });
    checked(result, "ANALYZE_LOT_SYNC_FAILED");
    const syncReport = SyncLotAnalysisResultSchema.safeParse(result.data);
    if (!syncReport.success) {
      throw new Error("ANALYZE_LOT_SYNC_INVALID_RESPONSE");
    }
    if (syncReport.data.matched === 0 || syncReport.data.unmatched > 0) {
      throw new AnalyzeLotSyncUnmatchedError(
        syncReport.data.matched,
        syncReport.data.unmatched,
        syncReport.data.locked,
      );
    }
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

export interface SupabaseAnalyzeStoreOptions {
  recordTypes?: readonly AnalyzeRecordType[];
  logger?: WorkerLogger;
}

export function createSupabaseAnalyzeStore(
  client: AnalyzeSupabaseClient,
  options: SupabaseAnalyzeStoreOptions = {},
): SupabaseAnalyzeStore {
  const recordTypes = options.recordTypes ?? DEFAULT_ANALYZE_RECORD_TYPES;
  return {
    async peekCandidates(limit, observedAt) {
      // The perimeter gate: only tenders whose record_type is in scope are
      // even visible as candidates (never claimed, never marked). The embed
      // is qualified on the single tender_id FK so PostgREST cannot pick an
      // ambiguous relationship, and !inner turns the .in() into a row filter.
      const result = await (client.from("dce_analysis_queue") as {
        select(columns: string): {
          in(column: string, values: string[]): {
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
        };
      }).select("id,tender_id,attempts,tender!tender_id!inner(record_type)")
        .in("tender.record_type", [...recordTypes])
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
      return {
        write: (payload) =>
          writeAnalysis(client, assembly, payload, options.logger),
      };
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
