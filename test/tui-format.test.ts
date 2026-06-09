import { describe, expect, test } from "bun:test";
import { pct, bar } from "../src/tui/format.ts";

describe("pct", () => {
  test("formats a whole percent", () => {
    expect(pct(73)).toBe("73%");
  });
  test("rounds to avoid jitter", () => {
    expect(pct(72.4)).toBe("72%");
    expect(pct(72.6)).toBe("73%");
  });
  test("zero", () => {
    expect(pct(0)).toBe("0%");
  });
  test("over 100 is not clamped (caller clamps)", () => {
    expect(pct(150)).toBe("150%");
  });
  test("NaN and Infinity render an em dash", () => {
    expect(pct(NaN)).toBe("—");
    expect(pct(Infinity)).toBe("—");
    expect(pct(-Infinity)).toBe("—");
  });
});

describe("bar", () => {
  test("empty at zero value", () => {
    expect(bar(0, 100, 10)).toBe("░".repeat(10));
  });
  test("full at max", () => {
    expect(bar(100, 100, 10)).toBe("█".repeat(10));
  });
  test("half full", () => {
    const b = bar(50, 100, 10);
    expect(b).toHaveLength(10);
    expect(b).toBe("█".repeat(5) + "░".repeat(5));
  });
  test("over max clamps to full", () => {
    expect(bar(200, 100, 8)).toBe("█".repeat(8));
  });
  test("negative value clamps to empty", () => {
    expect(bar(-5, 100, 8)).toBe("░".repeat(8));
  });
  test("max <= 0 yields an empty bar, not a crash", () => {
    expect(bar(5, 0, 6)).toBe("░".repeat(6));
    expect(bar(5, -1, 6)).toBe("░".repeat(6));
  });
  test("width 0 yields an empty string", () => {
    expect(bar(50, 100, 0)).toBe("");
  });
  test("negative width yields an empty string", () => {
    expect(bar(50, 100, -3)).toBe("");
  });
  test("always returns exactly `width` characters for positive width", () => {
    for (const v of [0, 1, 13, 49, 50, 99, 100]) {
      expect([...bar(v, 100, 12)]).toHaveLength(12);
    }
  });
  test("NaN value or max is treated as empty", () => {
    expect(bar(NaN, 100, 5)).toBe("░".repeat(5));
    expect(bar(5, NaN, 5)).toBe("░".repeat(5));
  });
});
