import { z } from "zod";

export const ReaderModeSchema = z.enum(["off", "dry_run", "apply"]);
export type ReaderMode = z.infer<typeof ReaderModeSchema>;

export interface ReaderConfig {
  mode: ReaderMode;
  batch: number;
  model: string;
  /** Modèle de secours de la cascade lecteur. `null` = cascade désactivée. */
  modelFallback: string | null;
  /** Pourcentage (0-100) de pièces réussies auditées contre le modèle de secours. */
  auditSamplePercent: number;
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  openRouterApiKey: string | undefined;
  nukemaUsername: string | undefined;
  nukemaPassword: string | undefined;
  maxBytes: number;
  maxModelBytes: number;
  heartbeatMs: number;
  pollMs: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percent(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : fallback;
}

const DEFAULT_FALLBACK_MODEL = "google/gemini-3.5-flash";

function fallbackModel(value: string | undefined): string | null {
  if (value === undefined) return DEFAULT_FALLBACK_MODEL;
  return nonEmpty(value) ?? null;
}

function required(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = nonEmpty(env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadReaderConfig(
  env: Readonly<Record<string, string | undefined>>,
): ReaderConfig {
  const mode = ReaderModeSchema.parse(env.READER_MODE ?? "off");
  const common = {
    mode,
    batch: positiveInt(env.READER_BATCH, 2),
    model:
      nonEmpty(env.OPENROUTER_MODEL_EXTRACT) ?? "google/gemini-3.5-flash",
    modelFallback: fallbackModel(env.OPENROUTER_MODEL_EXTRACT_FALLBACK),
    auditSamplePercent: percent(env.READER_AUDIT_SAMPLE_PERCENT, 5),
    maxBytes: positiveInt(
      env.READER_MAX_BYTES ?? env.DOCUMENT_EXTRACTOR_MAX_BYTES,
      300 * 1024 * 1024,
    ),
    maxModelBytes: positiveInt(env.READER_MAX_MODEL_BYTES, 20 * 1024 * 1024),
    heartbeatMs: positiveInt(env.READER_HEARTBEAT_MS, 30_000),
    pollMs: positiveInt(env.READER_POLL_MS, 5_000),
  };

  if (mode === "off") {
    return {
      ...common,
      supabaseUrl: undefined,
      supabaseServiceRoleKey: undefined,
      openRouterApiKey: undefined,
      nukemaUsername: undefined,
      nukemaPassword: undefined,
    };
  }

  return {
    ...common,
    supabaseUrl: required(env, "SUPABASE_URL").replace(/\/+$/, ""),
    supabaseServiceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    openRouterApiKey: required(env, "OPENROUTER_API_KEY"),
    nukemaUsername: required(env, "NUKEMA_USERNAME"),
    nukemaPassword: required(env, "NUKEMA_PASSWORD"),
  };
}
