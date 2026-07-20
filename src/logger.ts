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

export class JsonLineLogger implements WorkerLogger {
  constructor(
    private readonly output: Pick<NodeJS.WritableStream, "write"> =
      process.stderr,
  ) {}

  info(event: string, record: LogRecord): void {
    this.output.write(
      `${JSON.stringify({ event, ...sanitizeLogRecord(record) })}\n`,
    );
  }
}
