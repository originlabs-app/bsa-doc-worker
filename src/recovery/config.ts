import { z } from "zod";

import { RecoveryModeSchema, type RecoveryMode } from "../contracts.js";

const BatchSizeSchema = z.coerce.number().int().min(1).max(100);

export const RECOVERY_MAX_BYTES = 256 * 1024 * 1024;

export interface RecoveryConfig {
  mode: RecoveryMode;
  batchSize: number;
  maxBytes: number;
}

export function loadRecoveryConfig(
  env: Readonly<Record<string, string | undefined>>,
): RecoveryConfig {
  return {
    mode: RecoveryModeSchema.parse(env.RECOVERY_MODE ?? "off"),
    batchSize: BatchSizeSchema.parse(env.RECOVERY_BATCH_SIZE ?? "25"),
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
  return values.hour === "07";
}
