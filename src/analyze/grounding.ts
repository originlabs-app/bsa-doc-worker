import type { AnalyzeDocumentInput } from "./agent-types.js";
import {
  LotBusinessFieldsSchema,
  type AgentAnalysisDraft,
  type LotBusinessFields,
} from "./types.js";

/**
 * LOT D — grounding of the documentary business fields.
 *
 * The draft schema only proves that a citation is a non-empty string: an
 * invented citation would sail through. Every present business field is
 * therefore re-grounded against the assembled dossier:
 *  1. strict per-field schema (defensive re-validation),
 *  2. the designated documentId must exist in the dossier,
 *  3. the citation must appear verbatim (whitespace/case-normalized) in the
 *     text of THAT document — the evidence sent to the RPC names its
 *     role/fileName, so the citation must come from the named document,
 *  4. for estimatedValue, the amount must be readable in the citation itself
 *     (exact port of the edge citationSupportsLotAmount semantics).
 * A failed check degrades the field to null (dedicated log), never an
 * exception: the analysis stays valid, the unproven value is simply absent.
 */

export type BusinessFieldKey = keyof LotBusinessFields;

export const BUSINESS_FIELD_KEYS = [
  "summaryDescription",
  "contractDuration",
  "workStartDate",
  "estimatedValue",
] as const satisfies readonly BusinessFieldKey[];

export type BusinessFieldDegradeReason =
  | "schema_invalid"
  | "unknown_document"
  | "citation_not_found"
  | "amount_not_in_citation";

export type BusinessFieldGrounding =
  | {
    ok: true;
    document: AnalyzeDocumentInput;
    value: string | number;
    citation: string;
  }
  | { ok: false; reason: BusinessFieldDegradeReason };

export type GroundingLog = (
  event: string,
  data: Record<string, unknown>,
) => void;

// Exact port of the edge parseDocumentaryNumberToken (analyze-dce/handler.ts):
// French number formats — spaces/NBSP/apostrophes as group separators, comma
// or dot as decimal separator depending on position.
export function parseDocumentaryNumberToken(value: string): number | null {
  const compact = value.replace(/[\s\u00a0\u202f'’]/g, "");
  if (!/^\d[\d.,]*$/.test(compact)) return null;

  const commaIndex = compact.lastIndexOf(",");
  const dotIndex = compact.lastIndexOf(".");
  let normalized = compact;
  if (commaIndex >= 0 && dotIndex >= 0) {
    const decimalSeparator = commaIndex > dotIndex ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = compact.replaceAll(thousandsSeparator, "");
    normalized = normalized.replace(decimalSeparator, ".");
  } else if (commaIndex >= 0) {
    const decimalDigits = compact.length - commaIndex - 1;
    normalized = decimalDigits <= 2
      ? compact.replace(",", ".")
      : compact.replaceAll(",", "");
  } else if (dotIndex >= 0) {
    const groups = compact.split(".");
    normalized = groups.length > 2 || groups.at(-1)?.length === 3
      ? groups.join("")
      : compact;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

// Exact port of the edge citationSupportsLotAmount (analyze-dce/handler.ts):
// the asserted amount must be readable in the citation, with the French
// format tolerances above plus k€/M€ (or keur/meur) multipliers.
export function citationSupportsLotAmount(
  citation: string,
  amount: number,
): boolean {
  const amountPattern =
    /(\d(?:[\d\s\u00a0\u202f.,'’]*\d)?)(?:\s*([km])\s*(?:€|eur))?/giu;
  for (const match of citation.matchAll(amountPattern)) {
    const parsed = parseDocumentaryNumberToken(match[1] ?? "");
    if (parsed === null) continue;
    const multiplier = match[2]?.toLowerCase() === "k"
      ? 1_000
      : match[2]?.toLowerCase() === "m"
        ? 1_000_000
        : 1;
    if (Math.abs(parsed * multiplier - amount) < 0.005) return true;
  }
  return false;
}

// Whitespace/case normalization used to search a citation inside a document
// text: any whitespace run (incl. NBSP/narrow NBSP) collapses to one space.
function normalizeForGrounding(text: string): string {
  return text.toLocaleLowerCase("fr").replace(/\s+/g, " ").trim();
}

/**
 * Grounds one business field entry against the assembled documents. Returns
 * null for an absent field (nothing to prove), otherwise the grounding
 * verdict with the resolved source document on success.
 */
export function groundBusinessField(
  field: BusinessFieldKey,
  entry: LotBusinessFields[BusinessFieldKey],
  documents: readonly AnalyzeDocumentInput[],
): BusinessFieldGrounding | null {
  const schema = LotBusinessFieldsSchema.shape[field] as {
    safeParse(value: unknown):
      | {
        success: true;
        data: { value: string | number; citation: string; documentId: string } | null;
      }
      | { success: false };
  };
  const parsed = schema.safeParse(entry);
  if (!parsed.success) return { ok: false, reason: "schema_invalid" };
  if (parsed.data === null) return null;

  const document = documents.find((candidate) =>
    candidate.id === parsed.data?.documentId
  );
  if (!document) return { ok: false, reason: "unknown_document" };

  const citation = normalizeForGrounding(parsed.data.citation);
  if (!normalizeForGrounding(document.text).includes(citation)) {
    return { ok: false, reason: "citation_not_found" };
  }

  if (
    field === "estimatedValue" &&
    !citationSupportsLotAmount(
      parsed.data.citation,
      parsed.data.value as number,
    )
  ) {
    return { ok: false, reason: "amount_not_in_citation" };
  }

  return {
    ok: true,
    document,
    value: parsed.data.value,
    citation: parsed.data.citation,
  };
}

/**
 * Returns a draft whose ungrounded business fields are degraded to null.
 * Runs right after the structured draft is accepted, so the persisted
 * analysis details and every downstream RPC only ever see proven fields.
 */
export function degradeUngroundedBusinessFields(input: {
  draft: AgentAnalysisDraft;
  documents: readonly AnalyzeDocumentInput[];
  tenderId?: string;
  log?: GroundingLog;
}): AgentAnalysisDraft {
  const units = input.draft.units.map((unit) => {
    if (!unit.businessFields) return unit;
    const fields = { ...unit.businessFields };
    for (const field of BUSINESS_FIELD_KEYS) {
      const grounding = groundBusinessField(
        field,
        fields[field],
        input.documents,
      );
      if (grounding === null || grounding.ok) continue;
      const documentId = fields[field] &&
          typeof fields[field] === "object" &&
          "documentId" in (fields[field] as object)
        ? (fields[field] as { documentId?: unknown }).documentId
        : null;
      input.log?.("analyze_business_field_degraded", {
        ...(input.tenderId ? { tender_id: input.tenderId } : {}),
        unit: unit.unit.kind === "lot" ? unit.unit.number : "market",
        field,
        reason: grounding.reason,
        document_id: typeof documentId === "string" ? documentId : null,
      });
      fields[field] = null;
    }
    return { ...unit, businessFields: fields };
  });
  return { ...input.draft, units };
}
