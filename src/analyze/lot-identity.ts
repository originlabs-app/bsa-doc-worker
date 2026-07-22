import { createHash } from "node:crypto";

import type { AnalysisLotValues } from "./service.js";

export interface ExistingLotIdentity {
  id: string;
  sourceLotKey: string | null;
  number: string | null;
  title: string | null;
  order: number;
}

export type LotIdentityIssueCode =
  | "lot_zero_unresolved"
  | "duplicate_candidate_identity"
  | "ambiguous_existing_identity"
  | "existing_identity_missing_source_key";

export interface LotIdentityIssue {
  code: LotIdentityIssueCode;
  candidateIndex: number;
  identity: string;
  existingLotIds?: string[];
}

export interface ReconciledLotIdentities {
  lots: AnalysisLotValues[];
  issues: LotIdentityIssue[];
}

interface CandidateIdentity {
  candidateIndex: number;
  lot: AnalysisLotValues;
  number: string | null;
  titleIdentity: string;
  order: number;
  identity: string;
  sourceLotKey: string;
}

// Same lot-number normalization family as the edge (handler.ts
// normalizeLotNumberValue): "Lot n°01a" -> "1A". Zero is never canonical.
export function normalizeLotNumberValue(value: string | null): string | null {
  if (value === null) return null;
  const match = value.trim().match(
    /^(?:lot\s*(?:n\s*[°ºo]?\s*)?)?0*([0-9]{1,3})([a-z]?)$/i,
  );
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0
    ? `${parsed}${(match[2] ?? "").toUpperCase()}`
    : null;
}

function positiveLotNumberFromTitle(title: string | null): string | null {
  if (!title) return null;
  const matches = title.matchAll(
    /\blot\s*(?:n\s*[°ºo]?\s*)?0*([0-9]{1,3})([a-z]?)\b/gi,
  );
  for (const match of matches) {
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > 0) {
      return `${parsed}${(match[2] ?? "").toUpperCase()}`;
    }
  }
  return null;
}

function containsExplicitZero(value: string | null): boolean {
  if (!value) return false;
  return /^(?:lot\s*(?:n\s*[°ºo]?\s*)?)?0+$/i.test(value.trim());
}

function containsTitleLotZero(value: string | null): boolean {
  return value !== null &&
    /\blot\s*(?:n\s*[°ºo]?\s*)?0+\b/i.test(value);
}

function normalizeTitle(value: string | null): string {
  return (value ?? "")
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\blot\s*(?:n\s*[°ºo]?\s*)?0*[0-9]{1,3}[a-z]?\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSourceKey(titleIdentity: string, order: number): string {
  const digest = createHash("sha256")
    .update(titleIdentity)
    .digest("hex")
    .slice(0, 16);
  return `title:${digest}:order:${order}`;
}

function existingIdentity(existing: ExistingLotIdentity): string {
  const number = normalizeLotNumberValue(existing.number) ??
    positiveLotNumberFromTitle(existing.title);
  if (number) return `number:${number}`;
  return `title:${normalizeTitle(existing.title)}:order:${existing.order}`;
}

function canonicalCandidates(
  lots: readonly AnalysisLotValues[],
): { candidates: CandidateIdentity[]; issues: LotIdentityIssue[] } {
  const issues: LotIdentityIssue[] = [];
  const preliminary = lots.flatMap((lot, candidateIndex) => {
    const rawNumber = normalizeLotNumberValue(lot.number);
    const titleNumber = positiveLotNumberFromTitle(lot.title);
    const number = rawNumber ?? titleNumber;
    if (
      !number &&
      (containsExplicitZero(lot.number) || containsTitleLotZero(lot.title))
    ) {
      issues.push({
        code: "lot_zero_unresolved",
        candidateIndex,
        identity: "number:0",
      });
      return [];
    }
    return [{
      candidateIndex,
      lot,
      number,
      titleIdentity: normalizeTitle(lot.title),
    }];
  });

  const ordered = [...preliminary].sort((left, right) => {
    if (left.number !== null && right.number !== null) {
      return left.number.localeCompare(right.number, "fr", { numeric: true }) ||
        left.candidateIndex - right.candidateIndex;
    }
    if (left.number !== null) return -1;
    if (right.number !== null) return 1;
    return left.titleIdentity.localeCompare(right.titleIdentity, "fr") ||
      left.candidateIndex - right.candidateIndex;
  });
  const fallbackOrder = new Map(
    ordered.map((candidate, order) => [candidate.candidateIndex, order]),
  );

  return {
    candidates: ordered.map((candidate) => {
      if (candidate.number !== null) {
        const identity = `number:${candidate.number}`;
        return {
          ...candidate,
          order: candidate.candidateIndex,
          identity,
          sourceLotKey: identity.toLocaleLowerCase("fr"),
        };
      }
      const order = fallbackOrder.get(candidate.candidateIndex) ?? 0;
      return {
        ...candidate,
        order,
        identity: `title:${candidate.titleIdentity}:order:${order}`,
        sourceLotKey: titleSourceKey(candidate.titleIdentity, order),
      };
    }),
    issues,
  };
}

/**
 * Reconciles documentary candidates against live children before any RPC.
 * Identity priority is deliberately independent from source_lot_key:
 * reliable number, number extracted from title, then normalized title+order.
 * Existing source keys are reused so a replay cannot create a logical sibling.
 */
export function reconcileLotIdentities(
  lots: readonly AnalysisLotValues[],
  existingLots: readonly ExistingLotIdentity[],
): ReconciledLotIdentities {
  const canonical = canonicalCandidates(lots);
  const issues = [...canonical.issues];
  const uniqueCandidates: CandidateIdentity[] = [];
  const seenCandidateIdentities = new Set<string>();
  for (const candidate of canonical.candidates) {
    if (seenCandidateIdentities.has(candidate.identity)) {
      issues.push({
        code: "duplicate_candidate_identity",
        candidateIndex: candidate.candidateIndex,
        identity: candidate.identity,
      });
      continue;
    }
    seenCandidateIdentities.add(candidate.identity);
    uniqueCandidates.push(candidate);
  }

  const existingByIdentity = new Map<string, ExistingLotIdentity[]>();
  for (const existing of existingLots) {
    const identity = existingIdentity(existing);
    const matches = existingByIdentity.get(identity) ?? [];
    matches.push(existing);
    existingByIdentity.set(identity, matches);
  }

  const reconciled = uniqueCandidates.flatMap((candidate) => {
    const matches = existingByIdentity.get(candidate.identity) ?? [];
    if (matches.length > 1) {
      issues.push({
        code: "ambiguous_existing_identity",
        candidateIndex: candidate.candidateIndex,
        identity: candidate.identity,
        existingLotIds: matches.map((match) => match.id),
      });
      return [];
    }
    const match = matches[0];
    if (match && match.sourceLotKey === null) {
      issues.push({
        code: "existing_identity_missing_source_key",
        candidateIndex: candidate.candidateIndex,
        identity: candidate.identity,
        existingLotIds: [match.id],
      });
      return [];
    }
    return [{
      ...candidate.lot,
      number: candidate.number,
      sourceLotKey: match?.sourceLotKey ?? candidate.sourceLotKey,
    }];
  });

  return { lots: reconciled, issues };
}
