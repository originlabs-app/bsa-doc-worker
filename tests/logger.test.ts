import { describe, expect, it } from "vitest";

import {
  JsonLineLogger,
  logLevelForEvent,
  sanitizeLogRecord,
} from "../src/logger.js";

describe("sanitizeLogRecord", () => {
  it("redacts URLs, secrets, cookies and CAPTCHA material defensively", () => {
    const sanitized = sanitizeLogRecord({
      sourceUrl: "https://example.test/path?CFID=123&CFTOKEN=456",
      browserlessToken: "token-value",
      cookieHeader: "CFID=123; CFTOKEN=456",
      captchaValue: "answer",
      sourceHost: "www.marches-publics.info",
    });

    expect(sanitized).toEqual({
      sourceUrl: "[REDACTED]",
      browserlessToken: "[REDACTED]",
      cookieHeader: "[REDACTED]",
      captchaValue: "[REDACTED]",
      sourceHost: "www.marches-publics.info",
    });
  });
});

describe("logLevelForEvent", () => {
  it("keeps normal lifecycle events at info", () => {
    expect(logLevelForEvent("reader_started", { mode: "apply" })).toBe("info");
    expect(logLevelForEvent("analyze_started", { mode: "shadow" })).toBe(
      "info",
    );
    expect(logLevelForEvent("recovery_started", { mode: "dry_run" })).toBe(
      "info",
    );
    expect(
      logLevelForEvent("reader_stopped", {
        mode: "off",
        reason: "READER_MODE_OFF",
      }),
    ).toBe("info");
    expect(
      logLevelForEvent("analyze_stopped", {
        mode: "off",
        reason: "ANALYZE_MODE_OFF",
      }),
    ).toBe("info");
    expect(
      logLevelForEvent("recovery_stopped", { mode: "shadow", n_error: 0 }),
    ).toBe("info");
    expect(logLevelForEvent("browserless_usage", { status: "measured" })).toBe(
      "info",
    );
  });

  it("reserves error for real failures", () => {
    expect(
      logLevelForEvent("analyze_error_detail", { queue_id: "q-1" }),
    ).toBe("error");
    expect(
      logLevelForEvent("reader_start_failed", {
        issue: "READER_CONFIG_INVALID",
      }),
    ).toBe("error");
    expect(
      logLevelForEvent("analyze_one_shot_failed", { queue_id: "q-1" }),
    ).toBe("error");
    expect(
      logLevelForEvent("adapter_attempt_failed", { adapter: "place" }),
    ).toBe("error");
    expect(
      logLevelForEvent("analyze_row_terminal", { queue_id: "q-1" }),
    ).toBe("error");
  });

  it("treats stopped events carrying an issue as errors", () => {
    expect(
      logLevelForEvent("reader_stopped", { issue: "READER_SERVICE_FAILED" }),
    ).toBe("error");
    expect(
      logLevelForEvent("analyze_stopped", { issue: "ANALYZE_SERVICE_FAILED" }),
    ).toBe("error");
    expect(
      logLevelForEvent("recovery_stopped", {
        issue: "RECOVERY_SERVICE_FAILED",
      }),
    ).toBe("error");
  });
});

describe("JsonLineLogger", () => {
  function capture() {
    const lines: string[] = [];
    return {
      lines,
      output: {
        write(chunk: string) {
          lines.push(chunk);
        },
      },
    };
  }

  it("writes info-level events to the info output with unchanged JSON shape", () => {
    const info = capture();
    const error = capture();
    const logger = new JsonLineLogger(info.output, error.output);

    logger.info("reader_started", { mode: "apply", release: "abc123" });

    expect(error.lines).toEqual([]);
    expect(info.lines).toHaveLength(1);
    expect(JSON.parse(info.lines[0] ?? "")).toEqual({
      event: "reader_started",
      mode: "apply",
      release: "abc123",
    });
  });

  it("writes failure events to the error output", () => {
    const info = capture();
    const error = capture();
    const logger = new JsonLineLogger(info.output, error.output);

    logger.info("analyze_error_detail", { queue_id: "q-1" });
    logger.info("reader_stopped", { issue: "READER_SERVICE_FAILED" });

    expect(info.lines).toEqual([]);
    expect(error.lines).toHaveLength(2);
    expect(JSON.parse(error.lines[0] ?? "")).toEqual({
      event: "analyze_error_detail",
      queue_id: "q-1",
    });
  });

  it("still sanitizes sensitive keys on both levels", () => {
    const info = capture();
    const error = capture();
    const logger = new JsonLineLogger(info.output, error.output);

    logger.info("recovery_started", { sourceUrl: "https://secret.test" });
    logger.info("recovery_fetch_failed", { browserlessToken: "tok" });

    expect(JSON.parse(info.lines[0] ?? "").sourceUrl).toBe("[REDACTED]");
    expect(JSON.parse(error.lines[0] ?? "").browserlessToken).toBe("[REDACTED]");
  });
});
