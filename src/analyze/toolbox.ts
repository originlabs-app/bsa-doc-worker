import { evaluateRedhibitoryRules } from "./redhibitory.js";
import type {
  AnalyzeDossierInput,
  AnalyzeLearningSnapshot,
} from "./agent-types.js";

const DOCUMENT_WINDOW_CHARACTERS = 20_000;

export interface AnalysisToolLimits {
  documentReadCalls: number;
  documentReadCharacters: number;
  companyProfileCalls: number;
  learningRecallCalls: number;
  redhibitoryCheckCalls: number;
}

const DEFAULT_LIMITS: AnalysisToolLimits = {
  documentReadCalls: 64,
  documentReadCharacters: 1_000_000,
  companyProfileCalls: 2,
  learningRecallCalls: 2,
  redhibitoryCheckCalls: 32,
};

export class AnalyzeToolBudgetError extends Error {
  readonly code = "ANALYZE_TOOL_BUDGET_EXCEEDED";

  constructor(public readonly toolName: string) {
    super("ANALYZE_TOOL_BUDGET_EXCEEDED");
    this.name = "AnalyzeToolBudgetError";
  }
}

export class AnalyzeToolInputError extends Error {
  readonly code = "ANALYZE_TOOL_INPUT_INVALID";

  constructor() {
    super("ANALYZE_TOOL_INPUT_INVALID");
    this.name = "AnalyzeToolInputError";
  }
}

export interface AnalysisToolbox {
  readDocument(input: { documentId: string; cursor: number }): {
    documentId: string;
    fileName: string;
    role: string;
    lotNumber: string | null;
    text: string;
    start: number;
    end: number;
    hasMore: boolean;
    nextCursor: number | null;
  };
  consultCompanyProfile(): AnalyzeDossierInput["company"];
  recallLearning(): AnalyzeLearningSnapshot;
  checkRedhibitoryRules(input: {
    requiredQualifications: Array<{ label: string }>;
    socialInsertion: { present: boolean; detail?: string | null } | null;
  }): ReturnType<typeof evaluateRedhibitoryRules>;
  trace(): {
    documentReadCalls: number;
    documentReadCharacters: number;
    companyProfileCalls: number;
    learningRecallCalls: number;
    redhibitoryCheckCalls: number;
    budgetExceeded: boolean;
  };
}

export function createAnalysisToolbox(input: {
  dossier: AnalyzeDossierInput;
  learning: AnalyzeLearningSnapshot;
  limits?: Partial<AnalysisToolLimits>;
}): AnalysisToolbox {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const counters = {
    documentReadCalls: 0,
    documentReadCharacters: 0,
    companyProfileCalls: 0,
    learningRecallCalls: 0,
    redhibitoryCheckCalls: 0,
  };
  let budgetExceeded = false;

  function consume(counter: keyof typeof counters, limit: number, tool: string): void {
    if (counters[counter] >= limit) {
      budgetExceeded = true;
      throw new AnalyzeToolBudgetError(tool);
    }
    counters[counter] += 1;
  }

  return {
    readDocument({ documentId, cursor }) {
      consume("documentReadCalls", limits.documentReadCalls, "read_document");
      const document = input.dossier.documents.find((item) => item.id === documentId);
      if (!document || !Number.isSafeInteger(cursor) || cursor < 0) {
        throw new AnalyzeToolInputError();
      }
      const remaining = limits.documentReadCharacters - counters.documentReadCharacters;
      if (remaining <= 0) {
        budgetExceeded = true;
        throw new AnalyzeToolBudgetError("read_document");
      }
      const length = Math.min(DOCUMENT_WINDOW_CHARACTERS, remaining);
      const text = document.text.slice(cursor, cursor + length);
      counters.documentReadCharacters += text.length;
      const end = cursor + text.length;
      const hasMore = end < document.text.length;
      return {
        documentId: document.id,
        fileName: document.fileName,
        role: document.role,
        lotNumber: document.lotNumber,
        text,
        start: cursor,
        end,
        hasMore,
        nextCursor: hasMore ? end : null,
      };
    },
    consultCompanyProfile() {
      consume("companyProfileCalls", limits.companyProfileCalls, "consult_company_profile");
      return input.dossier.company;
    },
    recallLearning() {
      consume("learningRecallCalls", limits.learningRecallCalls, "recall_learning");
      return input.learning;
    },
    checkRedhibitoryRules(request) {
      consume(
        "redhibitoryCheckCalls",
        limits.redhibitoryCheckCalls,
        "check_redhibitory_rules",
      );
      return evaluateRedhibitoryRules({
        requiredQualifications: request.requiredQualifications,
        mandatoryQualifications: input.dossier.mandatoryQualifications,
        company: input.dossier.company,
        socialInsertion: request.socialInsertion,
      });
    },
    trace() {
      return { ...counters, budgetExceeded };
    },
  };
}
