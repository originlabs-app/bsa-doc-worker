import type {
  AnalyzeLearningSnapshot,
  AnalyzeTenderInput,
  ApprovedLearningRule,
  SimilarLesson,
} from "./agent-types.js";

const DEFAULT_TOP_K = 5;
const MIN_GO_SIMILARITY = 0.65;
const EXPECTED_EMBEDDING_DIMENSIONS = 768;
const OPENROUTER_EMBEDDING_URL = "https://openrouter.ai/api/v1/embeddings";
export const LESSON_EMBEDDING_MODEL = "google/gemini-embedding-2";

export interface ApprovedLearningRuleRecord extends ApprovedLearningRule {
  matchTerms: string[];
  negativeTerms: string[];
}

export interface LearningMemoryStore {
  matchLessons(input: {
    companyId: string;
    embedding: string;
    embeddingModel: string;
    limit: number;
  }): Promise<SimilarLesson[]>;
  listApprovedRules(companyId: string): Promise<ApprovedLearningRuleRecord[]>;
  recordRuleUsage(ruleIds: string[]): Promise<void>;
}

export type LearningEmbedder = (text: string) => Promise<number[]>;

interface SupabaseResult {
  data: unknown;
  error: unknown;
}

interface ApprovedRuleQuery {
  select(columns: string): {
    eq(column: string, value: unknown): {
      eq(column: string, value: unknown): {
        eq(column: string, value: unknown): Promise<SupabaseResult>;
      };
    };
  };
}

export interface SupabaseLearningClient {
  rpc(functionName: string, args: Record<string, unknown>): Promise<SupabaseResult>;
  from(table: string): ApprovedRuleQuery;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tenderSearchText(tender: AnalyzeTenderInput): string {
  return normalize([
    tender.title,
    tender.buyerName,
    tender.description,
    tender.location,
    tender.procedureType,
  ].filter((value): value is string => Boolean(value)).join("\n"));
}

function tenderEmbeddingText(tender: AnalyzeTenderInput): string {
  return [
    `Titre: ${tender.title}`,
    tender.buyerName ? `Acheteur: ${tender.buyerName}` : null,
    tender.description ? `Description: ${tender.description}` : null,
    tender.location ? `Localisation: ${tender.location}` : null,
    tender.procedureType ? `Procédure: ${tender.procedureType}` : null,
  ].filter((value): value is string => value !== null).join("\n");
}

function appliesToTender(
  rule: ApprovedLearningRuleRecord,
  searchableTender: string,
): boolean {
  const negativeMatch = rule.negativeTerms.some((term) => {
    const normalized = normalize(term);
    return normalized !== "" && searchableTender.includes(normalized);
  });
  if (negativeMatch) return false;
  if (rule.matchTerms.length === 0) return true;
  return rule.matchTerms.some((term) => {
    const normalized = normalize(term);
    return normalized !== "" && searchableTender.includes(normalized);
  });
}

function publicRule(rule: ApprovedLearningRuleRecord): ApprovedLearningRule {
  return {
    id: rule.id,
    title: rule.title,
    description: rule.description,
    recommendedAction: rule.recommendedAction,
    patternType: rule.patternType,
    confidence: rule.confidence,
  };
}

function buildContext(
  lessons: SimilarLesson[],
  rules: ApprovedLearningRule[],
): string {
  const sections: string[] = [];
  if (lessons.length > 0) {
    sections.push([
      "LEÇONS DE DOSSIERS SIMILAIRES (repères, jamais des décisions automatiques):",
      ...lessons.map((lesson) =>
        `- [${lesson.kind.toUpperCase()} · similarité ${lesson.similarity.toFixed(2)}] ${lesson.title} (${lesson.tenderRef}): ${lesson.lessonText}`
      ),
    ].join("\n"));
  }
  if (rules.length > 0) {
    sections.push([
      "RÈGLES D'APPRENTISSAGE APPROUVÉES À CONSIDÉRER:",
      ...rules.map((rule) =>
        `- ${rule.title}: ${rule.description}${rule.recommendedAction ? ` Action recommandée: ${rule.recommendedAction}` : ""}`
      ),
    ].join("\n"));
  }
  return sections.join("\n\n");
}

export function formatVector(values: number[]): string {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding contains a non-finite value");
  }
  return `[${values.join(",")}]`;
}

export async function embedText(
  text: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<number[]> {
  if (!apiKey.trim()) {
    throw new Error("OPENROUTER_API_KEY is required for lesson recall");
  }
  const response = await fetchFn(OPENROUTER_EMBEDDING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: LESSON_EMBEDDING_MODEL,
      input: text,
      dimensions: EXPECTED_EMBEDDING_DIMENSIONS,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenRouter embeddings ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  const parsed = body ? JSON.parse(body) as unknown : {};
  const values = parsed && typeof parsed === "object" && "data" in parsed &&
      Array.isArray(parsed.data) && parsed.data[0] &&
      typeof parsed.data[0] === "object" && "embedding" in parsed.data[0]
    ? parsed.data[0].embedding
    : undefined;
  if (!Array.isArray(values)) {
    throw new Error("OpenRouter embeddings response missing data[0].embedding");
  }
  if (values.length !== EXPECTED_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `OpenRouter embeddings dimension mismatch: got ${values.length}, expected ${EXPECTED_EMBEDDING_DIMENSIONS}`,
    );
  }
  const embedding = values.map(Number);
  formatVector(embedding);
  return embedding;
}

function parseSimilarLesson(row: unknown): SimilarLesson | null {
  if (!row || typeof row !== "object") return null;
  const raw = row as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.kind !== "string" ||
    !["go", "pending_go", "no_go", "rejected"].includes(raw.kind) ||
    typeof raw.title !== "string" ||
    typeof raw.lesson_text !== "string"
  ) return null;
  const similarity = Number(raw.similarity);
  return {
    id: raw.id,
    kind: raw.kind as SimilarLesson["kind"],
    tenderRef: typeof raw.tender_ref === "string" ? raw.tender_ref : raw.id,
    title: raw.title,
    lessonText: raw.lesson_text,
    decidedAt: typeof raw.decided_at === "string" ? raw.decided_at : "",
    similarity: Number.isFinite(similarity) ? similarity : 0,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseApprovedRule(row: unknown): ApprovedLearningRuleRecord | null {
  if (!row || typeof row !== "object") return null;
  const raw = row as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.title !== "string") return null;
  return {
    id: raw.id,
    title: raw.title,
    description: typeof raw.description === "string" ? raw.description : "",
    recommendedAction: typeof raw.recommended_action === "string"
      ? raw.recommended_action
      : null,
    matchTerms: stringArray(raw.match_terms),
    negativeTerms: stringArray(raw.negative_terms),
    patternType: typeof raw.pattern_type === "string"
      ? raw.pattern_type
      : "business_exclusion",
    confidence: typeof raw.confidence === "string" ? raw.confidence : "medium",
  };
}

function throwIfSupabaseError(result: SupabaseResult): void {
  if (result.error) {
    throw result.error instanceof Error
      ? result.error
      : new Error(String(result.error));
  }
}

export function createSupabaseLearningMemoryStore(
  client: SupabaseLearningClient,
): LearningMemoryStore {
  return {
    async matchLessons(input) {
      const result = await client.rpc("match_ao_lessons", {
        p_company_id: input.companyId,
        p_embedding: input.embedding,
        p_embedding_model: input.embeddingModel,
        p_k: input.limit,
      });
      throwIfSupabaseError(result);
      return (Array.isArray(result.data) ? result.data : [])
        .map(parseSimilarLesson)
        .filter((lesson): lesson is SimilarLesson => lesson !== null);
    },
    async listApprovedRules(companyId) {
      const result = await client
        .from("scraping_memory")
        .select(
          "id,title,description,recommended_action,match_terms,negative_terms,pattern_type,confidence",
        )
        .eq("scope", "company")
        .eq("company_id", companyId)
        .eq("status", "approved");
      throwIfSupabaseError(result);
      return (Array.isArray(result.data) ? result.data : [])
        .map(parseApprovedRule)
        .filter((rule): rule is ApprovedLearningRuleRecord => rule !== null);
    },
    async recordRuleUsage(ruleIds) {
      const uniqueIds = [...new Set(ruleIds)];
      if (uniqueIds.length === 0) return;
      const result = await client.rpc("record_scraping_memory_usage", {
        p_memory_ids: uniqueIds,
      });
      throwIfSupabaseError(result);
    },
  };
}

export function selectLessonsForPrompt(
  lessons: SimilarLesson[],
  options: { topK?: number; minGoSimilarity?: number } = {},
): SimilarLesson[] {
  const topK = options.topK ?? DEFAULT_TOP_K;
  if (!Number.isSafeInteger(topK) || topK < 1) return [];
  const sorted = [...lessons].sort((left, right) => right.similarity - left.similarity);
  const selected = sorted.slice(0, topK);
  if (selected.some((lesson) => lesson.kind === "go")) return selected;

  const bestGo = sorted.find((lesson) =>
    lesson.kind === "go" &&
    lesson.similarity >= (options.minGoSimilarity ?? MIN_GO_SIMILARITY)
  );
  if (bestGo && selected.length > 0) selected[selected.length - 1] = bestGo;
  return selected;
}

export async function buildAnalyzeLearningSnapshot(input: {
  enabled: boolean;
  companyId: string;
  tender: AnalyzeTenderInput;
  store: LearningMemoryStore;
  embed: LearningEmbedder;
  topK?: number;
  embeddingModel?: string;
}): Promise<AnalyzeLearningSnapshot> {
  if (!input.enabled) return { lessons: [], rules: [], context: "" };

  const topK = input.topK ?? DEFAULT_TOP_K;
  const lessonsPromise = (async () => {
    const embedding = await input.embed(tenderEmbeddingText(input.tender));
    if (embedding.length !== EXPECTED_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding must contain ${EXPECTED_EMBEDDING_DIMENSIONS} dimensions`,
      );
    }
    const candidates = await input.store.matchLessons({
      companyId: input.companyId,
      embedding: formatVector(embedding),
      embeddingModel: input.embeddingModel ?? LESSON_EMBEDDING_MODEL,
      limit: Math.max(topK * 3, DEFAULT_TOP_K),
    });
    return selectLessonsForPrompt(candidates, { topK });
  })().catch(() => [] as SimilarLesson[]);

  const rulesPromise = input.store.listApprovedRules(input.companyId)
    .then((rules) => rules
      .filter((rule) => appliesToTender(rule, tenderSearchText(input.tender)))
      .map(publicRule))
    .catch(() => [] as ApprovedLearningRule[]);

  const [lessons, rules] = await Promise.all([lessonsPromise, rulesPromise]);
  return { lessons, rules, context: buildContext(lessons, rules) };
}
