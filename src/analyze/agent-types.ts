import type { DocumentReaderRole } from "../llm/document-schemas.js";
import type {
  AgentAnalysisDraft,
  CompanyProfile,
  MandatoryQualification,
} from "./types.js";

export interface AnalyzeTenderInput {
  id: string;
  title: string;
  buyerName: string | null;
  description: string | null;
  location: string | null;
  estimatedAmount: number | null;
  procedureType: string | null;
}

export interface AnalyzeDocumentInput {
  id: string;
  fileName: string;
  role: DocumentReaderRole;
  lotNumber: string | null;
  text: string;
}

export interface AnalyzeDossierInput {
  tender: AnalyzeTenderInput;
  company: CompanyProfile;
  mandatoryQualifications: MandatoryQualification[];
  documents: AnalyzeDocumentInput[];
  /** Present only for a direct lot analysis: the precise lot to analyze. */
  targetLot?: { number: string | null; title: string | null } | null;
}

export type LessonKind = "go" | "pending_go" | "no_go" | "rejected";

export interface SimilarLesson {
  id: string;
  kind: LessonKind;
  tenderRef: string;
  title: string;
  lessonText: string;
  decidedAt: string;
  similarity: number;
}

export interface ApprovedLearningRule {
  id: string;
  title: string;
  description: string;
  recommendedAction: string | null;
  patternType: string;
  confidence: string;
}

export interface AnalyzeLearningSnapshot {
  lessons: SimilarLesson[];
  rules: ApprovedLearningRule[];
  context: string;
}

export interface AnalyzeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** One lot of the market roster, as enumerated by the framing call. */
export interface AnalyzeRosterLot {
  number: string;
  title: string;
}

/**
 * LOT H — chunked analysis of large allotted markets. A mission narrows one
 * LLM call to a bounded sub-task whose expected output always fits in
 * maxOutputTokens: `framing` produces the condensed market context and the
 * full lot roster; `chunk` analyzes exactly the lots of one slice. A request
 * without mission is the legacy single-call full-dossier analysis
 * (standalone tenders, direct lots, small markets).
 */
export type AnalyzeCallMission =
  | {
      kind: "framing";
      /** Lot numbers attested by the assembled documents (analysis_lot_number). */
      expectedLotNumbers: string[];
      /** Minimum roster size (max of DB lot children and document lot numbers). */
      expectedLotCount: number;
    }
  | {
      kind: "chunk";
      /** 1-based slice index. */
      index: number;
      total: number;
      lots: AnalyzeRosterLot[];
      framing: { marketSummary: string; watchpoints: string[] };
    };

export interface AgentGenerationRequest {
  dossier: AnalyzeDossierInput;
  learning: AnalyzeLearningSnapshot;
  repair: boolean;
  maxSteps: number;
  maxOutputTokens: number;
  /** Absent = legacy single-call full-dossier analysis. */
  mission?: AnalyzeCallMission;
}

export interface AgentGenerationResult {
  output: unknown;
  stepsUsed: number;
  costUsd: number;
  usage: AnalyzeUsage;
}

export interface AgentGenerationClient {
  generate(input: AgentGenerationRequest): Promise<AgentGenerationResult>;
}

export interface DceAnalystResult {
  draft: AgentAnalysisDraft;
  attempts: number;
  stepsUsed: number;
  costUsd: number;
  usage: AnalyzeUsage;
}
