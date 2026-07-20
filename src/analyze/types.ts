import { z } from "zod";

export const CriterionKeySchema = z.enum([
  "metier",
  "geo",
  "montant",
  "procedure",
  "certifications",
]);
export type CriterionKey = z.infer<typeof CriterionKeySchema>;

export const CriterionScoresSchema = z.object({
  metier: z.number().min(0).max(30),
  geo: z.number().min(0).max(20),
  montant: z.number().min(0).max(20),
  procedure: z.number().min(0).max(15),
  certifications: z.number().min(0).max(15),
}).strict();
export type CriterionScores = z.infer<typeof CriterionScoresSchema>;

const shortText = z.string().trim().min(1).max(2_000);
const evidenceText = z.string().trim().min(1).max(1_000);

export const AnalysisUnitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("market") }).strict(),
  z.object({
    kind: z.literal("lot"),
    number: z.string().trim().min(1).max(32),
    title: z.string().trim().min(1).max(500),
  }).strict(),
]);

export const RichSummarySchema = z.object({
  scope: shortText,
  services: z.array(shortText).max(50),
  requirements: z.array(shortText).max(50),
  qualifications: z.array(shortText).max(50),
  amounts: z.array(shortText).max(50),
  watchpoints: z.array(shortText).max(50),
}).strict();

export const AnalysisUnitDraftSchema = z.object({
  unit: AnalysisUnitSchema,
  proposedVerdict: z.enum(["favorable", "uncertain", "unfavorable"]),
  rationale: shortText,
  criteria: CriterionScoresSchema,
  unknownCriteria: z.array(CriterionKeySchema).max(5),
  summary: RichSummarySchema,
  requiredQualifications: z.array(z.object({
    label: z.string().trim().min(1).max(500),
    sourceDocumentId: z.string().trim().min(1).max(200),
    evidence: evidenceText,
  }).strict()).max(100),
  socialInsertion: z.object({
    present: z.boolean(),
    detail: z.string().trim().min(1).max(1_000).nullable(),
    sourceDocumentId: z.string().trim().min(1).max(200).nullable(),
  }).strict().nullable(),
  citations: z.array(z.object({
    documentId: z.string().trim().min(1).max(200),
    excerpt: evidenceText,
  }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  const uniqueUnknown = new Set(value.unknownCriteria);
  if (uniqueUnknown.size !== value.unknownCriteria.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["unknownCriteria"],
      message: "Unknown criteria must be unique",
    });
  }
  for (const criterion of uniqueUnknown) {
    if (value.criteria[criterion] !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["criteria", criterion],
        message: "An unknown criterion cannot receive points",
      });
    }
  }
});

export const AgentAnalysisDraftSchema = z.object({
  marketSummary: z.string().trim().min(1).max(2_000),
  units: z.array(AnalysisUnitDraftSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const markets = value.units.filter((entry) => entry.unit.kind === "market");
  if (markets.length > 0 && (markets.length !== 1 || value.units.length !== 1)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["units"],
      message: "A non-allotted market must contain exactly one market unit",
    });
  }
  const lotNumbers = value.units.flatMap((entry) =>
    entry.unit.kind === "lot" ? [entry.unit.number] : []
  );
  if (new Set(lotNumbers).size !== lotNumbers.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["units"],
      message: "Lot numbers must be unique",
    });
  }
});
export type AgentAnalysisDraft = z.infer<typeof AgentAnalysisDraftSchema>;

export interface CompanyProfile {
  name?: string | null;
  core_business?: string | null;
  desired_contracts?: string | null;
  code_naf?: string | null;
  search_keywords?: string[] | null;
  exclusion_keywords?: string[] | null;
  search_departments?: string[] | null;
  search_city?: string | null;
  search_radius_km?: number | null;
  search_market_types?: string[] | null;
  certifications_held?: string[] | null;
  certifications_excluded?: string[] | null;
  accepts_social_insertion?: boolean | null;
}

export interface MandatoryQualification {
  code: string;
  label: string;
  derogeable: boolean;
  aliases: string[] | null;
}

export interface QualificationMatch {
  code: string;
  label: string;
  requiredLabel: string;
  held: boolean;
  excluded: boolean;
  derogeable: boolean;
}

export type FinalUnitVerdict =
  | "blocked"
  | "recommended"
  | "relevant"
  | "watch"
  | "out_of_scope";

export type FinalAnalysisUnit = AgentAnalysisDraft["units"][number] & {
  score: number;
  forcedZero: boolean;
  verdict: FinalUnitVerdict;
  redhibitoryReasons: string[];
  redhibitoryWatchpoints: string[];
  matchedMandatoryQualifications: QualificationMatch[];
};

export interface FinalizedAnalysis {
  score: number;
  reason: string;
  forcedZero: boolean;
  marketSummary: string;
  recommendedLot: { number: string; title: string } | null;
  watchpoints: string[];
  units: FinalAnalysisUnit[];
}
