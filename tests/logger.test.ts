import { describe, expect, it } from "vitest";

import { sanitizeLogRecord } from "../src/logger.js";

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
