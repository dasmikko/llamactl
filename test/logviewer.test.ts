/**
 * Unit tests for the LogViewer's line sanitizer. Build tools emit carriage
 * returns and ANSI escapes that would corrupt the TUI; sanitizeLogLine must
 * reduce each captured line to the plain text a terminal would leave on screen.
 */

import { describe, expect, test } from "bun:test";
import { sanitizeLogLine } from "../src/tui/LogViewer.tsx";

describe("sanitizeLogLine", () => {
  test("collapses carriage-return progress redraws to the final segment", () => {
    expect(sanitizeLogLine("[1/100]\r[2/100]\r[3/100]")).toBe("[3/100]");
  });

  test("drops a trailing CRLF carriage return without blanking the line", () => {
    expect(sanitizeLogLine("Linking llama-server\r")).toBe("Linking llama-server");
  });

  test("strips ANSI color escape sequences", () => {
    expect(sanitizeLogLine("\x1b[32mOK\x1b[0m built")).toBe("OK built");
  });

  test("removes stray control characters", () => {
    expect(sanitizeLogLine("a\x07b\x08c")).toBe("abc");
  });

  test("leaves a plain line untouched", () => {
    expect(sanitizeLogLine("configuring cmake")).toBe("configuring cmake");
  });

  test("a pure carriage-return line becomes empty", () => {
    expect(sanitizeLogLine("\r")).toBe("");
  });
});
