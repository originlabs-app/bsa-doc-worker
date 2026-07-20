import { z } from "zod";

import {
  MAX_ANALYZE_OUTPUT_TOKENS,
  MAX_ANALYZE_STEPS,
} from "./agent.js";

export const AnalyzeModeSchema = z.enum(["off", "dry_run", "apply"]);
export type AnalyzeMode = z.infer<typeof AnalyzeModeSchema>;

export interface AnalyzeConfig {
  mode: AnalyzeMode;
  model: string;
  maxSteps: number;
  maxOutputTokens: number;
  openRouterApiKey: string | undefined;
}

const DEFAULT_ANALYZE_MODEL = "openai/gpt-5.6-terra";

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function boundedInteger(input: {
  name: string;
  rawValue: string | undefined;
  defaultValue: number;
  maximum: number;
}): number {
  if (input.rawValue === undefined || input.rawValue.trim() === "") {
    return input.defaultValue;
  }
  const value = Number(input.rawValue);
  if (!Number.isSafeInteger(value) || value < 1 || value > input.maximum) {
    throw new Error(`${input.name} must be an integer between 1 and ${input.maximum}`);
  }
  return value;
}

export function loadAnalyzeConfig(
  env: Readonly<Record<string, string | undefined>>,
): AnalyzeConfig {
  const mode = AnalyzeModeSchema.parse(env.ANALYZE_MODE ?? "off");
  const openRouterApiKey = nonEmpty(env.OPENROUTER_API_KEY);
  if (mode !== "off" && !openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required when ANALYZE_MODE is enabled");
  }

  return {
    mode,
    model: nonEmpty(env.OPENROUTER_MODEL_SCORE) ?? DEFAULT_ANALYZE_MODEL,
    maxSteps: boundedInteger({
      name: "ANALYZE_MAX_STEPS",
      rawValue: env.ANALYZE_MAX_STEPS,
      defaultValue: 8,
      maximum: MAX_ANALYZE_STEPS,
    }),
    maxOutputTokens: boundedInteger({
      name: "ANALYZE_MAX_OUTPUT_TOKENS",
      rawValue: env.ANALYZE_MAX_OUTPUT_TOKENS,
      defaultValue: MAX_ANALYZE_OUTPUT_TOKENS,
      maximum: MAX_ANALYZE_OUTPUT_TOKENS,
    }),
    openRouterApiKey,
  };
}
