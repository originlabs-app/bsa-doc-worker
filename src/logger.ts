const SENSITIVE_KEY =
  /(token|password|secret|cookie|captcha|cfid|cftoken|(^|_)url$|url$)/i;

export type LogRecord = Readonly<Record<string, unknown>>;

function sanitizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue("arrayItem", item));
  }
  if (value !== null && typeof value === "object") {
    return sanitizeLogRecord(value as Record<string, unknown>);
  }
  return value;
}

export function sanitizeLogRecord(record: LogRecord): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      sanitizeValue(key, value),
    ]),
  );
}

export interface WorkerLogger {
  info(event: string, record: LogRecord): void;
}

export interface TextOutput {
  write(chunk: string): unknown;
}

export type LogLevel = "info" | "error";

const ERROR_EVENT = /(_failed|_terminal|_error)(_|$)/;

/**
 * Level is derived from the event itself so every call site can keep using
 * `info()`: real failures (`*_failed`, `*_terminal`, `*_error*`, or any
 * record carrying a short typed `issue`) go to stderr as errors; normal
 * lifecycle events (`*_started`, `*_stopped` off/summary, usage reports)
 * stay on stdout as plain info lines.
 */
export function logLevelForEvent(event: string, record: LogRecord): LogLevel {
  if (ERROR_EVENT.test(event)) return "error";
  if (typeof record["issue"] === "string") return "error";
  return "info";
}

export class JsonLineLogger implements WorkerLogger {
  constructor(
    private readonly infoOutput: TextOutput = process.stdout,
    private readonly errorOutput: TextOutput = process.stderr,
  ) {}

  info(event: string, record: LogRecord): void {
    const output =
      logLevelForEvent(event, record) === "error"
        ? this.errorOutput
        : this.infoOutput;
    output.write(
      `${JSON.stringify({ event, ...sanitizeLogRecord(record) })}\n`,
    );
  }
}
