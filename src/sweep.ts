export type SweepProtocol = "A" | "B";

export interface SweepIdentity {
  protocol: SweepProtocol;
  title: string;
  reference: string;
  buyerName: string;
}

export interface SweepCandidateIdentity {
  canonicalTitle: string;
  reference: string;
  buyerName: string;
}

export type SweepMatchDecision =
  | {
      accepted: true;
      matchedBy:
        | "source_portal_exact_title"
        | "exact_reference"
        | "exact_buyer_and_title";
    }
  | {
      accepted: false;
      reason: "target_identity_missing" | "strict_identity_mismatch";
    };

function normalizeWords(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
}

function strictTitleMatches(targetTitle: string, canonicalTitle: string): boolean {
  const target = normalizeWords(targetTitle);
  const candidate = normalizeWords(canonicalTitle);
  return target.length >= 20 && candidate.startsWith(target);
}

function exactReferenceMatches(target: string, candidate: string): boolean {
  return (
    target.trim().length > 0 &&
    target.trim().toLocaleUpperCase("fr-FR") ===
      candidate.trim().toLocaleUpperCase("fr-FR")
  );
}

export function classifySweepCandidate(
  target: SweepIdentity,
  candidate: SweepCandidateIdentity,
): SweepMatchDecision {
  if (
    target.protocol === "A" &&
    strictTitleMatches(target.title, candidate.canonicalTitle)
  ) {
    return { accepted: true, matchedBy: "source_portal_exact_title" };
  }

  if (exactReferenceMatches(target.reference, candidate.reference)) {
    return { accepted: true, matchedBy: "exact_reference" };
  }

  if (!target.reference.trim() && !target.buyerName.trim()) {
    return { accepted: false, reason: "target_identity_missing" };
  }

  if (
    target.buyerName.trim() &&
    normalizeWords(target.buyerName) === normalizeWords(candidate.buyerName) &&
    strictTitleMatches(target.title, candidate.canonicalTitle)
  ) {
    return { accepted: true, matchedBy: "exact_buyer_and_title" };
  }

  return { accepted: false, reason: "strict_identity_mismatch" };
}
