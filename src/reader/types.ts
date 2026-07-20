import type { DocumentReaderRole } from "../llm/document-schemas.js";

export type AnalysisRole = Exclude<DocumentReaderRole, "inconnu">;

export type ExtractionStatus =
  | "extracted"
  | "word_extracted"
  | "extracted_ocr"
  | "empty_text"
  | "failed"
  | "unsupported_format"
  | "source_expired"
  | "too_large"
  | "empty_file";

export type DocumentKind =
  | "pdf"
  | "docx"
  | "doc"
  | "spreadsheet"
  | "zip"
  | "unknown";

export interface ClaimedDocument {
  queue_id: string;
  attempts: number;
  claimed_at: string;
  document_id: string;
  tender_id: string;
  company_id: string;
  file_name: string;
  url: string;
  source_url: string | null;
  source_reference: string | null;
  analysis_role: AnalysisRole | null;
  extraction_status: "oversized_document";
}

export interface ExtractionNote {
  entry: string;
  kind: DocumentKind;
  status: string;
  bytes?: number;
  sourceBytes?: number;
  sentBytes?: number;
  pageCount?: number;
  pages?: string;
  depth?: number;
  reason?: string;
  magicHex?: string;
}

export interface MaterializedZipChild {
  document_id: string;
  tender_id: string;
  parent_document_id: string;
  file_name: string;
  url: string;
}

export interface ZipChildUpsertInput {
  queueId: string;
  workerId: string;
  entryPath: string;
  fileName: string;
  analysisRole: AnalysisRole | null;
  analysisRoleSource: "filename" | "content" | null;
  extractionStatus: ExtractionStatus;
}

export interface AiSpendDraft {
  tenderId: string;
  model: string;
  costUsd: number;
  metadata: Record<string, unknown>;
}

export interface CompleteExtractionInput {
  queueId: string;
  workerId: string;
  extractionStatus: ExtractionStatus;
  textStoragePath: string | null;
  model: string | null;
  costUsd: number;
  notes: ExtractionNote[];
}
