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

export interface AgentGenerationRequest {
  dossier: AnalyzeDossierInput;
  learning: AnalyzeLearningSnapshot;
  repair: boolean;
  maxSteps: number;
  maxOutputTokens: number;
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
