import type {
  CompanyProfile,
  MandatoryQualification,
  QualificationMatch,
} from "./types.js";

export interface RedhibitoryInput {
  requiredQualifications: Array<{ label: string }>;
  mandatoryQualifications: MandatoryQualification[];
  company: CompanyProfile;
  socialInsertion?: { present: boolean; detail?: string | null } | null;
}

export interface RedhibitoryEvaluation {
  redhibitory: boolean;
  reasons: string[];
  watchpoints: string[];
  matchedMandatoryQualifications: QualificationMatch[];
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedSet(values: string[] | null | undefined): Set<string> {
  return new Set((values ?? []).map(normalize).filter(Boolean));
}

function aliases(qualification: MandatoryQualification): string[] {
  return [qualification.code, qualification.label, ...(qualification.aliases ?? [])]
    .map(normalize)
    .filter(Boolean);
}

function matches(requiredLabel: string, qualification: MandatoryQualification): boolean {
  const required = normalize(requiredLabel);
  return required.length > 0 && aliases(qualification).some(
    (alias) => required === alias || required.includes(alias) || alias.includes(required),
  );
}

/** Parity source: BSA Copilot origin/main@a185631 redhibitory-rules.ts. */
export function evaluateRedhibitoryRules(
  input: RedhibitoryInput,
): RedhibitoryEvaluation {
  const held = normalizedSet(input.company.certifications_held);
  const excluded = normalizedSet(input.company.certifications_excluded);
  const reasons: string[] = [];
  const watchpoints: string[] = [];
  const matchedMandatoryQualifications: QualificationMatch[] = [];

  for (const required of input.requiredQualifications) {
    for (const mandatory of input.mandatoryQualifications) {
      if (!matches(required.label, mandatory)) continue;
      const names = aliases(mandatory);
      const isHeld = names.some((name) => held.has(name));
      const isExcluded = names.some((name) => excluded.has(name));
      matchedMandatoryQualifications.push({
        code: mandatory.code,
        label: mandatory.label,
        requiredLabel: required.label,
        held: isHeld,
        excluded: isExcluded,
        derogeable: mandatory.derogeable,
      });
      if (isExcluded) {
        reasons.push(
          `Qualification ${mandatory.label} exigée mais exclue par le profil client.`,
        );
      } else if (!mandatory.derogeable && !isHeld) {
        reasons.push(
          `Qualification indérogeable ${mandatory.label} exigée mais absente du profil client.`,
        );
      }
    }
  }

  if (input.socialInsertion?.present) {
    if (input.company.accepts_social_insertion === false) {
      reasons.push(
        "Clause d'insertion sociale détectée alors que le profil client la refuse.",
      );
    } else if (input.company.accepts_social_insertion == null) {
      watchpoints.push(
        "Clause d'insertion sociale détectée; préférence client non renseignée.",
      );
    }
  }

  return {
    redhibitory: reasons.length > 0,
    reasons,
    watchpoints,
    matchedMandatoryQualifications,
  };
}
