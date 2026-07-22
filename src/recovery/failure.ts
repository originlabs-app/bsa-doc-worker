import type {
  RecoveryFailure,
  RecoveryFailureStage,
  RecoveryFailureType,
} from "./contracts.js";

interface FailureShape {
  reasonCode?: unknown;
  retryable?: unknown;
  failureStage?: unknown;
  failureType?: unknown;
  failureMessage?: unknown;
  code?: unknown;
  cause?: unknown;
}

const FAILURE_STAGES = new Set<RecoveryFailureStage>([
  "identification",
  "browser_connect",
  "navigation",
  "authentication",
  "captcha",
  "lot_selection",
  "manifest",
  "download",
  "upload",
  "persistence",
]);
const FAILURE_TYPES = new Set<RecoveryFailureType>([
  "login",
  "navigation",
  "captcha",
  "download",
  "network",
  "external_portal",
  "validation",
  "storage",
  "unknown",
]);

export function sanitizeRecoveryFailureMessage(value: string): string {
  return value
    .replace(
      /https?:\/\/[^\s?#"'<>]+(?:\?[^\s#"'<>]*)?(?:#[^\s"'<>]*)?/gi,
      (raw) => raw.replace(/[?#].*$/, "?[REDACTED]"),
    )
    .replace(
      /\b(token|password|secret|cookie|cfid|cftoken)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

function shaped(error: unknown): FailureShape {
  return error && typeof error === "object" ? error as FailureShape : {};
}

function stringMember(
  value: unknown,
  allowed: ReadonlySet<string>,
): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function networkSignal(error: unknown, message: string): boolean {
  const outer = shaped(error);
  const cause = shaped(outer.cause);
  const codes = [outer.code, cause.code]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|UND_ERR/i.test(codes) ||
    /fetch failed|socket|network|net::|timed?\s*out|aborted?/i.test(message);
}

function inferredStage(reasonCode: string | null): RecoveryFailureStage | null {
  if (/CAPTCHA/.test(reasonCode ?? "")) return "captcha";
  if (/AUTHENTICATION/.test(reasonCode ?? "")) return "authentication";
  if (/DOWNLOAD|DOCUMENT_TOO_LARGE/.test(reasonCode ?? "")) return "download";
  if (/PORTAL_SEARCH/.test(reasonCode ?? "")) return "identification";
  return null;
}

function inferredType(
  error: unknown,
  reasonCode: string | null,
  message: string,
): RecoveryFailureType {
  if (/CAPTCHA/.test(reasonCode ?? "")) return "captcha";
  if (/AUTHENTICATION/.test(reasonCode ?? "")) return "login";
  if (/DOWNLOAD/.test(reasonCode ?? "")) return "download";
  if (networkSignal(error, message)) return "network";
  return "unknown";
}

function typeForStage(stage: RecoveryFailureStage): RecoveryFailureType {
  if (stage === "authentication") return "login";
  if (stage === "captcha") return "captcha";
  if (stage === "download") return "download";
  if (stage === "upload" || stage === "persistence") return "storage";
  if (stage === "manifest") return "validation";
  if (stage === "browser_connect") return "network";
  if (stage === "navigation" || stage === "lot_selection") return "navigation";
  return "unknown";
}

export function toRecoveryFailure(
  error: unknown,
  fallback: {
    stage: RecoveryFailureStage;
    unitsSpent: number;
    type?: RecoveryFailureType;
    reasonCode?: string;
    retryable?: boolean;
    message?: string;
  },
): RecoveryFailure {
  const value = shaped(error);
  const reasonCode = typeof value.reasonCode === "string"
    ? value.reasonCode
    : fallback.reasonCode ?? null;
  const rawMessage = fallback.message ??
    (typeof value.failureMessage === "string"
      ? value.failureMessage
      : error instanceof Error
        ? error.message
        : String(error));
  const message = sanitizeRecoveryFailureMessage(rawMessage);
  const stage = stringMember(value.failureStage, FAILURE_STAGES) as
    | RecoveryFailureStage
    | undefined;
  const type = stringMember(value.failureType, FAILURE_TYPES) as
    | RecoveryFailureType
    | undefined;
  const inferred = inferredType(error, reasonCode, message);
  const resolvedStage = stage ?? inferredStage(reasonCode) ?? fallback.stage;
  return {
    stage: resolvedStage,
    type: type ?? fallback.type ??
      (inferred === "unknown" ? typeForStage(resolvedStage) : inferred),
    message,
    reason_code: reasonCode,
    retryable: typeof value.retryable === "boolean"
      ? value.retryable
      : fallback.retryable ?? null,
    units_spent: Math.max(0, fallback.unitsSpent),
  };
}
