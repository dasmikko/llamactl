/**
 * Pure formatting helpers for the TUI. Kept side-effect free and unit-testable.
 * Byte/uptime formatting is reused from the CLI layer rather than reimplemented.
 */

import { humanBytes, humanUptime } from "../cli/output.ts";

export { humanBytes, humanUptime };

/**
 * Format a 0..100-ish number as a whole-percent string, e.g. "73%".
 * Guards NaN/Infinity (renders "—") and rounds to avoid gauge jitter.
 */
export function pct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}

const FULL = "█";
const EMPTY = "░";

/**
 * A unicode block gauge sized to `width`. `value/max` fills the bar.
 * Guards max<=0 (renders an empty bar) and clamps the ratio to 0..1.
 * A width of 0 or less yields an empty string.
 */
export function bar(value: number, max: number, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return "";
  let ratio: number;
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(value)) {
    ratio = 0;
  } else {
    ratio = value / max;
  }
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  const filled = Math.round(ratio * w);
  return FULL.repeat(filled) + EMPTY.repeat(w - filled);
}
