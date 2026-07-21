import { z } from "zod";

import { RecoveryModeSchema, type RecoveryMode } from "../contracts.js";

const BatchSizeSchema = z.coerce.number().int().min(1).max(100);
const StrongThresholdSchema = z.coerce.number().min(0.5).max(0.7);
const TitleOnlyThresholdSchema = z.coerce.number().min(0.7).max(1);
const CronGuardSchema = z.enum(["off", "paris_0715"]);

export const RECOVERY_MAX_BYTES = 256 * 1024 * 1024;

export interface RecoveryConfig {
  mode: RecoveryMode;
  batchSize: number;
  strongTitleJaccard: number;
  titleOnlyJaccard: number;
  cronGuard: "off" | "paris_0715";
  maxBytes: number;
}

export function loadRecoveryConfig(
  env: Readonly<Record<string, string | undefined>>,
): RecoveryConfig {
  return {
    mode: RecoveryModeSchema.parse(env.RECOVERY_MODE ?? "off"),
    batchSize: BatchSizeSchema.parse(env.RECOVERY_BATCH_SIZE ?? "25"),
    strongTitleJaccard: StrongThresholdSchema.parse(
      env.RECOVERY_STRONG_TITLE_JACCARD ?? "0.50",
    ),
    titleOnlyJaccard: TitleOnlyThresholdSchema.parse(
      env.RECOVERY_TITLE_ONLY_JACCARD ?? "0.70",
    ),
    cronGuard: CronGuardSchema.parse(env.RECOVERY_CRON_GUARD ?? "off"),
    maxBytes: RECOVERY_MAX_BYTES,
  };
}

export function isParisCronWindow(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return values.hour === "07" && values.minute === "15";
}
