import type { AdapterDiscovery } from "../ports.js";

export const RECOVERY_PORTALS = [
  "aw_solutions",
  "place",
  "maximilien",
] as const;

export type RecoveryPortal = (typeof RECOVERY_PORTALS)[number];
export type RecoveryDecision = "exact" | "strong" | "medium" | "low";
export type RecoveryAttemptStatus =
  | "found"
  | "not_found"
  | "ambiguous"
  | "blocked"
  | "too_large"
  | "error";

export interface RecoveryTarget {
  tenderId: string;
  companyId: string;
  title: string;
  buyerName: string;
  reference: string;
  buyerProfileLink: string;
  lotTitles: string[];
}

export interface PortalCandidate {
  portal: RecoveryPortal;
  canonicalTitle: string;
  reference: string;
  buyerName: string;
  consultationUrl: string;
  lotTitles?: string[];
  deadlineAt?: string;
  recoveryDisposition?: "recoverable" | "external_blocked";
  blockedExternalHost?: string;
}

export interface PortalSearchResult {
  portal: RecoveryPortal;
  candidates: PortalCandidate[];
  blockedExternalHost?: string;
  requestCount?: number;
  errorCode?: string;
}

export interface MatchEvidence {
  level: RecoveryDecision;
  referenceExact: boolean;
  buyerExact: boolean;
  buyerMatched: boolean;
  buyerTokenOverlap: number;
  buyerSharedTokens: number;
  titleMatched: boolean;
  titlePrefixMatch: boolean;
  titleJaccard: number;
  lotTokenHits: number;
  lotTitleMatches: number;
  deadlineStatus: "coherent" | "expired" | "unknown";
  placeUmbrellaCompatible: boolean;
  candidate: PortalCandidate;
}

export interface RecoveryReservation {
  attemptId: string;
  attemptNumber: number;
}

export interface RecoveryStoredDocument {
  fileName: string;
  objectPath: string;
  sourceUrl: string;
  sourceReference: string;
  bytes: number;
  sha256: string;
}

export interface PreparedRecoveryBatch {
  documents: RecoveryStoredDocument[];
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RecoveryDocumentPipeline {
  fetchAndUpload(input: {
    target: RecoveryTarget;
    match: MatchEvidence;
    discovery: AdapterDiscovery;
  }): Promise<PreparedRecoveryBatch>;
}

export interface RecoveryAttemptStore {
  validateApplyReadiness(): Promise<void>;
  listEligible(limit: number): Promise<RecoveryTarget[]>;
  reserve(tenderId: string): Promise<RecoveryReservation | null>;
  finalize(input: {
    attemptId: string;
    status: Exclude<RecoveryAttemptStatus, "found">;
    portal: RecoveryPortal | null;
    decision: RecoveryDecision | "blocked" | "error";
    evidence: Record<string, unknown>;
  }): Promise<void>;
  persistFound(input: {
    attemptId: string;
    tenderId: string;
    portal: RecoveryPortal;
    decision: "exact" | "strong";
    evidence: Record<string, unknown>;
    documents: RecoveryStoredDocument[];
  }): Promise<{ insertedDocuments: number; queueStatus: string }>;
}

export class RecoveryTooLargeError extends Error {
  constructor() {
    super("RECOVERY_DOCUMENT_TOO_LARGE");
    this.name = "RecoveryTooLargeError";
  }
}
