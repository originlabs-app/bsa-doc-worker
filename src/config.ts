import {
  RecoveryModeSchema,
  RecoveryProviderSchema,
  type AdapterPlatform,
  type RecoveryMode,
  type RecoveryProvider,
} from "./contracts.js";

const REAL_SECRET_NAMES = [
  "BROWSERLESS_TOKEN",
  "AW_PORTAL_EMAIL",
  "AW_PORTAL_PASSWORD",
  "PLACE_PORTAL_EMAIL",
  "PLACE_PORTAL_PASSWORD",
  "MAXIMILIEN_PORTAL_EMAIL",
  "MAXIMILIEN_PORTAL_PASSWORD",
] as const;

export type RealSecretName = (typeof REAL_SECRET_NAMES)[number];

export function parseWorkerSecretEnv(
  source: string,
): Partial<Record<RealSecretName, string>> {
  const parsed: Partial<Record<RealSecretName, string>> = {};
  for (const line of source.split(/\r?\n/)) {
    for (const name of REAL_SECRET_NAMES) {
      const prefix = `${name}=`;
      if (!line.startsWith(prefix)) continue;
      if (parsed[name] !== undefined) {
        throw new Error("DUPLICATE_WORKER_SECRET");
      }
      const rawValue = line.slice(prefix.length).trim();
      const quote = rawValue[0];
      if (quote === '"' || quote === "'") {
        if (!rawValue.endsWith(quote) || rawValue.length < 2) {
          throw new Error("INVALID_WORKER_SECRET_ENV");
        }
        parsed[name] = rawValue.slice(1, -1);
      } else {
        parsed[name] = rawValue;
      }
    }
  }
  return parsed;
}

export interface WorkerConfig {
  mode: RecoveryMode;
  provider: RecoveryProvider;
  browserlessToken: string | undefined;
  awPortalEmail: string | undefined;
  awPortalPassword: string | undefined;
  placePortalEmail: string | undefined;
  placePortalPassword: string | undefined;
  maximilienPortalEmail: string | undefined;
  maximilienPortalPassword: string | undefined;
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
  const placePortalEmail = nonEmpty(env.PLACE_PORTAL_EMAIL);
  const placePortalPassword = nonEmpty(env.PLACE_PORTAL_PASSWORD);
  const maximilienPortalEmail = nonEmpty(env.MAXIMILIEN_PORTAL_EMAIL);
  const maximilienPortalPassword = nonEmpty(
    env.MAXIMILIEN_PORTAL_PASSWORD,
  );

  const byName: Record<RealSecretName, string | undefined> = {
    BROWSERLESS_TOKEN: browserlessToken,
    AW_PORTAL_EMAIL: awPortalEmail,
    AW_PORTAL_PASSWORD: awPortalPassword,
    PLACE_PORTAL_EMAIL: placePortalEmail,
    PLACE_PORTAL_PASSWORD: placePortalPassword,
    MAXIMILIEN_PORTAL_EMAIL: maximilienPortalEmail,
    MAXIMILIEN_PORTAL_PASSWORD: maximilienPortalPassword,
  };

  return {
    mode,
    provider,
    browserlessToken,
    awPortalEmail,
    awPortalPassword,
    placePortalEmail,
    placePortalPassword,
    maximilienPortalEmail,
    maximilienPortalPassword,
    missingRealSecrets:
      provider === "real"
        ? ([
            "BROWSERLESS_TOKEN",
            "AW_PORTAL_EMAIL",
            "AW_PORTAL_PASSWORD",
          ] as const).filter((name) => byName[name] === undefined)
        : [],
  };
}

const REQUIRED_REAL_SECRETS: Readonly<
  Record<AdapterPlatform, readonly RealSecretName[]>
> = {
  aw_solutions: [
    "BROWSERLESS_TOKEN",
    "AW_PORTAL_EMAIL",
    "AW_PORTAL_PASSWORD",
  ],
  place: [
    "BROWSERLESS_TOKEN",
    "PLACE_PORTAL_EMAIL",
    "PLACE_PORTAL_PASSWORD",
  ],
  maximilien: [
    "BROWSERLESS_TOKEN",
    "MAXIMILIEN_PORTAL_EMAIL",
    "MAXIMILIEN_PORTAL_PASSWORD",
  ],
};

export function missingRealSecretsForPlatform(
  config: WorkerConfig,
  platform: AdapterPlatform,
): RealSecretName[] {
  if (config.provider !== "real") return [];
  const values: Record<RealSecretName, string | undefined> = {
    BROWSERLESS_TOKEN: config.browserlessToken,
    AW_PORTAL_EMAIL: config.awPortalEmail,
    AW_PORTAL_PASSWORD: config.awPortalPassword,
    PLACE_PORTAL_EMAIL: config.placePortalEmail,
    PLACE_PORTAL_PASSWORD: config.placePortalPassword,
    MAXIMILIEN_PORTAL_EMAIL: config.maximilienPortalEmail,
    MAXIMILIEN_PORTAL_PASSWORD: config.maximilienPortalPassword,
  };
  return REQUIRED_REAL_SECRETS[platform].filter(
    (name) => values[name] === undefined,
  );
}
