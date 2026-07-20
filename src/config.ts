import {
  RecoveryModeSchema,
  RecoveryProviderSchema,
  type RecoveryMode,
  type RecoveryProvider,
} from "./contracts.js";

const REAL_SECRET_NAMES = [
  "BROWSERLESS_TOKEN",
  "AW_PORTAL_EMAIL",
  "AW_PORTAL_PASSWORD",
] as const;

export type RealSecretName = (typeof REAL_SECRET_NAMES)[number];

export interface WorkerConfig {
  mode: RecoveryMode;
  provider: RecoveryProvider;
  browserlessToken: string | undefined;
  awPortalEmail: string | undefined;
  awPortalPassword: string | undefined;
  missingRealSecrets: RealSecretName[];
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function loadWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkerConfig {
  const mode = RecoveryModeSchema.parse(env.RECOVERY_MODE ?? "off");
  const provider = RecoveryProviderSchema.parse(
    env.RECOVERY_PROVIDER ?? "mock",
  );
  const browserlessToken = nonEmpty(env.BROWSERLESS_TOKEN);
  const awPortalEmail = nonEmpty(env.AW_PORTAL_EMAIL);
  const awPortalPassword = nonEmpty(env.AW_PORTAL_PASSWORD);

  const byName: Record<RealSecretName, string | undefined> = {
    BROWSERLESS_TOKEN: browserlessToken,
    AW_PORTAL_EMAIL: awPortalEmail,
    AW_PORTAL_PASSWORD: awPortalPassword,
  };

  return {
    mode,
    provider,
    browserlessToken,
    awPortalEmail,
    awPortalPassword,
    missingRealSecrets:
      provider === "real"
        ? REAL_SECRET_NAMES.filter((name) => byName[name] === undefined)
        : [],
  };
}
